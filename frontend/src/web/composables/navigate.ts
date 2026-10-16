// Full-page navigation to an external URL (the OAuth redirect_to returned
// by the backend). Wrapped so tests can observe it.
export const externalNav = {
  assign(url: string): void {
    window.location.assign(url)
  },
}
