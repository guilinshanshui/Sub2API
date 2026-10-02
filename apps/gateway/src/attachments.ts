import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  ImageVariantId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageMediaType,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 12,
  maxMessageImageBytes: 30 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 12_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const ATTACHMENT_ID = /^att-[a-f0-9]{64}$/

/** Bounds-checked byte read; every caller has already proven the slice exists. */
function u8(data: Uint8Array, offset: number): number {
  const value = data[offset]
  if (value === undefined) throw new AttachmentError('Image bytes are truncated.', 'INVALID_IMAGE')
  return value
}

function u16le(data: Uint8Array, offset: number): number {
  return u8(data, offset) | (u8(data, offset + 1) << 8)
}

function u16be(data: Uint8Array, offset: number): number {
  return (u8(data, offset) << 8) | u8(data, offset + 1)
}

function u24le(data: Uint8Array, offset: number): number {
  return u8(data, offset) | (u8(data, offset + 1) << 8) | (u8(data, offset + 2) << 16)
}

function u32be(data: Uint8Array, offset: number): number {
  return ((u8(data, offset) << 24)
    | (u8(data, offset + 1) << 16)
    | (u8(data, offset + 2) << 8)
    | u8(data, offset + 3)) >>> 0
}

function matches(data: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (data.length < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (data[offset + index] !== signature[index]) return false
  }
  return true
}

/**
 * Detect the raster format from the leading bytes.
 *
 * The declared media type is never trusted on its own: browsers and SDKs label
 * data URLs from the file extension, so PNG names on JPEG bytes are common.
 */
function mediaTypeFromMagic(data: Uint8Array): ImageMediaType | undefined {
  if (matches(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (matches(data, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (matches(data, 0, [0x47, 0x49, 0x46, 0x38])
    && (data[4] === 0x37 || data[4] === 0x39)
    && data[5] === 0x61) return 'image/gif'
  if (matches(data, 0, [0x52, 0x49, 0x46, 0x46]) && matches(data, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp'
  }
  return undefined
}

function dimensions(data: Uint8Array, mediaType: ImageMediaType): { width: number; height: number } {
  if (mediaType === 'image/png') {
    if (data.length < 24) throw new AttachmentError('PNG image header is truncated.', 'INVALID_IMAGE')
    return { width: u32be(data, 16), height: u32be(data, 20) }
  }
  if (mediaType === 'image/gif') {
    if (data.length < 10) throw new AttachmentError('GIF image header is truncated.', 'INVALID_IMAGE')
    return { width: u16le(data, 6), height: u16le(data, 8) }
  }
  if (mediaType === 'image/webp') return webpDimensions(data)
  return jpegDimensions(data)
}

function jpegDimensions(data: Uint8Array): { width: number; height: number } {
  let offset = 2
  while (offset + 8 < data.length) {
    if (u8(data, offset) !== 0xff) {
      offset += 1
      continue
    }
    const marker = u8(data, offset + 1)
    offset += 2
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > data.length) break
    const length = u16be(data, offset)
    if (length < 2 || offset + length > data.length) break
    if ((marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) break
      return { width: u16be(data, offset + 5), height: u16be(data, offset + 3) }
    }
    offset += length
  }
  throw new AttachmentError('JPEG image dimensions could not be read.', 'INVALID_IMAGE')
}

function webpDimensions(data: Uint8Array): { width: number; height: number } {
  if (data.length < 30) throw new AttachmentError('WebP image header is truncated.', 'INVALID_IMAGE')
  const format = String.fromCharCode(u8(data, 12), u8(data, 13), u8(data, 14), u8(data, 15))
  if (format === 'VP8X') {
    return { width: u24le(data, 24) + 1, height: u24le(data, 27) + 1 }
  }
  if (format === 'VP8L') {
    const bits = u8(data, 21) | (u8(data, 22) << 8) | (u8(data, 23) << 16) | (u8(data, 24) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (format === 'VP8 ') {
    return {
      width: (u16le(data, 26) & 0x3fff),
      height: (u16le(data, 28) & 0x3fff),
    }
  }
  throw new AttachmentError('Unsupported WebP image encoding.', 'INVALID_IMAGE')
}

function validateDimensions(width: number, height: number): void {
  if (width <= 0 || height <= 0) throw new AttachmentError('Image dimensions are invalid.', 'INVALID_IMAGE')
  if (width > IMAGE_LIMITS.maxImageDimension || height > IMAGE_LIMITS.maxImageDimension) {
    throw new AttachmentError('Image dimension exceeds the configured limit.', 'IMAGE_DIMENSION_TOO_LARGE')
  }
  if (width * height > IMAGE_LIMITS.maxImagePixels) {
    throw new AttachmentError('Image pixel count exceeds the configured limit.', 'IMAGE_TOO_MANY_PIXELS')
  }
}

/**
 * Host-file-backed durable image store for the OpenAI-compatible gateway.
 *
 * Images are content-addressed by SHA-256 and written once; a reference carries
 * only intrinsic metadata, never a filesystem path. Request versions serve the
 * stored bytes because this deployment intentionally avoids a native image
 * codec dependency: the upstream adapters fall back to the original bytes
 * whenever downscaling is unavailable.
 */
export class LocalAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS

  constructor(ctx: Context, private readonly root: string) {
    super(ctx)
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    const mediaType = mediaTypeFromMagic(input.data)
    if (mediaType === undefined) {
      throw new AttachmentError('Image bytes are not a supported raster image.', 'INVALID_IMAGE')
    }
    if (mediaType !== input.mediaType) {
      throw new AttachmentError(
        `Declared image type ${input.mediaType} does not match ${mediaType}.`,
        'IMAGE_TYPE_MISMATCH',
      )
    }
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('Image exceeds the configured per-image byte limit.', 'IMAGE_TOO_LARGE')
    }
    const { width, height } = dimensions(input.data, mediaType)
    validateDimensions(width, height)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.validateImage(input)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const id = `att-${digest}`
    const { width, height } = dimensions(input.data, input.mediaType)
    const name = input.name === undefined ? undefined : path.basename(input.name).slice(0, 200)
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(id),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width,
      height,
      ...name === undefined || name.length === 0 ? {} : { name },
    }
    await fs.mkdir(this.root, { recursive: true })
    try {
      await fs.writeFile(this.filePath(id), input.data, { flag: 'wx' })
    } catch (error) {
      // Content addressing makes a lost publish race a success, not a fault.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AttachmentError(
          `Image could not be stored: ${error instanceof Error ? error.message : String(error)}`,
          'ATTACHMENT_WRITE_FAILED',
          { cause: error },
        )
      }
    }
    return ref
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    let stored: Buffer
    try {
      stored = await fs.readFile(this.filePath(String(ref.attachmentId)))
    } catch (error) {
      throw new AttachmentError(
        `Image is not stored: ${error instanceof Error ? error.message : String(error)}`,
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ATTACHMENT_NOT_FOUND' : 'ATTACHMENT_READ_FAILED',
        { cause: error },
      )
    }
    signal?.throwIfAborted()
    if (stored.byteLength !== ref.bytes) {
      throw new AttachmentError('Stored image length does not match its reference.', 'ATTACHMENT_CORRUPT')
    }
    const data = new Uint8Array(stored)
    if (mediaTypeFromMagic(data) !== ref.mediaType) {
      throw new AttachmentError('Stored image type does not match its reference.', 'ATTACHMENT_CORRUPT')
    }
    return { ref, data }
  }

  imageHostPath(ref: ImageAttachmentRef): string {
    return this.filePath(String(ref.attachmentId))
  }

  /**
   * Serve the stored bytes as the request version.
   *
   * The harness route target asks for a downscaled variant; without a codec we
   * return the original object under a deterministic variant id, which keeps
   * upstream inlining correct at the cost of larger request bodies.
   */
  async readImageRequest(
    ref: ImageAttachmentRef,
    _policy: unknown,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const { data } = await this.readImage(ref, signal)
    return {
      variantId: ImageVariantId(`req-${String(ref.attachmentId)}`),
      attachment: ref,
      data,
      mediaType: ref.mediaType,
      bytes: data.byteLength,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: ref.mediaType !== 'image/jpeg',
    }
  }

  private filePath(id: string): string {
    if (!ATTACHMENT_ID.test(id)) throw new AttachmentError('Attachment id is invalid.', 'INVALID_ATTACHMENT_REF')
    return path.join(this.root, `${id}.bin`)
  }
}
