// Backends whose stream shows one pane at the size the backend keeps, from
// its own screen renders: Herdr and herdr-core (hc). The pane size is
// theirs (a client may drive it), they answer terminal queries themselves,
// and a desktop shows a tab's panes side by side.
export function backendIsPaneStream(backend: string | undefined): boolean {
  return backend === 'herdr' || backend === 'hc'
}
