// session.ts — the active owner session shared across pages. The
// applications-space URI scopes every read/write; readerDid is the active
// session principal (advisory in v1).

export interface Session {
  appsSpaceUri: string;
  readerDid: string;
}
