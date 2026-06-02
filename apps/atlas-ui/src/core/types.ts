export interface VaultNote {
  id: string;           // relative path minus .md
  title: string;        // filename or frontmatter title
  path: string;         // full relative path
  folder: string;       // parent directory
  frontmatter: Record<string, unknown>;
  wikilinks: string[];  // resolved target IDs
  wordCount: number;
  created: number;      // epoch ms (from frontmatter or file stat)
  modified: number;     // epoch ms (from file stat)
}

export interface GraphEdge {
  id: string;
  source: string;       // node ID
  target: string;       // node ID
  type: string;         // wikilink, tag, folder, temporal, frontmatter, + future types
  weight: number;
}

export interface VaultGraph {
  nodes: VaultNote[];
  edges: GraphEdge[];
}

export interface GraphSource {
  load(): Promise<VaultGraph>;
  search(query: string): Promise<string[]>;  // returns node IDs
  getNote(id: string): Promise<string>;       // returns raw markdown
  reload?(): Promise<VaultGraph>;             // incremental reload
}
