// Defense in depth for the login / consent screens (spec_auth.md 4-6): the
// real protection is the frame-ancestors / X-Frame-Options response headers
// set by the backend; the SPA additionally refuses to render its controls
// when it finds itself inside a frame.
export function isFramed(win: Window = window): boolean {
  try {
    return win.top !== win.self
  } catch {
    // cross-origin parent: accessing top throws
    return true
  }
}
