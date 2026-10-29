// Folder selection exposes File handles only. Contents are read later inside the parse worker.
import type { SelectedContextFile } from '../worker/protocol.ts';
interface DirectoryHandle { kind: 'directory'; name: string; values(): AsyncIterable<FileHandle | DirectoryHandle> }
interface FileHandle { kind: 'file'; name: string; getFile(): Promise<File> }
export async function selectFolder(): Promise<SelectedContextFile[]> {
  const picker = (globalThis as unknown as { showDirectoryPicker?: () => Promise<DirectoryHandle> }).showDirectoryPicker;
  if (!picker) throw new Error('');
  const root = await picker();
  const out: SelectedContextFile[] = [];
  async function walk(directory: DirectoryHandle, prefix: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error('');
    for await (const child of directory.values()) {
      if (out.length >= 20_000) throw new Error('');
      const path = `${prefix}/${child.name}`;
      if (child.kind === 'directory') await walk(child, path, depth + 1);
      else out.push({ path, file: await child.getFile() });
    }
  }
  await walk(root, root.name, 0);
  return out;
}
export function folderFiles(files: FileList | null): SelectedContextFile[] {
  if (!files) return [];
  if (files.length > 20_000) throw new Error('');
  return Array.from(files, file => ({ path: file.webkitRelativePath || file.name, file }));
}
