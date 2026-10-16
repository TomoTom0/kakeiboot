// Backend origin used to pin image URLs (spec §11-6). Set `VITE_MEDIA_ORIGIN`
// at build time (e.g. https://<host>); when unset only the path prefix and
// scheme are checked and the resource CSP limits the actual load (spec §11-4).
const raw: unknown = import.meta.env.VITE_MEDIA_ORIGIN
export const MEDIA_ORIGIN: string | null = typeof raw === 'string' && raw.length > 0 ? raw : null
