import { RuntimeFileSearch } from './files/search/file-search'
import { RuntimeTerminalArtifacts } from './terminal/artifacts/terminal-artifacts'
import { RuntimeFileAccess } from './files/file-access'
import { RuntimeFileReads } from './files/file-reads'
import { RuntimeFileMutations } from './files/file-mutations'
import { RuntimeFileWatches } from './files/watch/file-watches'
import { RuntimeTerminalPathResolver } from './terminal/terminal-path-resolver'
import type { RuntimeFileCommandHost } from './files/file-command-host'

export class RuntimeFileCommands {
  private readonly search: RuntimeFileSearch
  private readonly artifacts: RuntimeTerminalArtifacts
  private readonly access: RuntimeFileAccess
  private readonly reads: RuntimeFileReads
  private readonly mutations: RuntimeFileMutations
  private readonly watches: RuntimeFileWatches
  private readonly terminalPaths: RuntimeTerminalPathResolver

  constructor(host: RuntimeFileCommandHost) {
    this.search = new RuntimeFileSearch(host)
    this.artifacts = new RuntimeTerminalArtifacts(host)
    this.access = new RuntimeFileAccess(host)
    this.reads = new RuntimeFileReads(host)
    this.mutations = new RuntimeFileMutations(host)
    this.watches = new RuntimeFileWatches(host)
    this.terminalPaths = new RuntimeTerminalPathResolver(host, this.artifacts)
  }

  listMobileFiles(...args: Parameters<RuntimeFileSearch['listMobileFiles']>) {
    return this.search.listMobileFiles(...args)
  }

  searchMobileFilePaths(...args: Parameters<RuntimeFileSearch['searchMobileFilePaths']>) {
    return this.search.searchMobileFilePaths(...args)
  }

  searchQuickOpenFilePaths(...args: Parameters<RuntimeFileSearch['searchQuickOpenFilePaths']>) {
    return this.search.searchQuickOpenFilePaths(...args)
  }

  searchRuntimeFiles(...args: Parameters<RuntimeFileSearch['searchRuntimeFiles']>) {
    return this.search.searchRuntimeFiles(...args)
  }

  listRuntimeFiles(...args: Parameters<RuntimeFileSearch['listRuntimeFiles']>) {
    return this.search.listRuntimeFiles(...args)
  }

  readTerminalArtifactFile(
    ...args: Parameters<RuntimeTerminalArtifacts['readTerminalArtifactFile']>
  ) {
    return this.artifacts.readTerminalArtifactFile(...args)
  }

  readTerminalArtifactPreview(
    ...args: Parameters<RuntimeTerminalArtifacts['readTerminalArtifactPreview']>
  ) {
    return this.artifacts.readTerminalArtifactPreview(...args)
  }

  writeTerminalArtifactFile(
    ...args: Parameters<RuntimeTerminalArtifacts['writeTerminalArtifactFile']>
  ) {
    return this.artifacts.writeTerminalArtifactFile(...args)
  }

  revokeTerminalFileGrantsForClient(
    ...args: Parameters<RuntimeTerminalArtifacts['revokeTerminalFileGrantsForClient']>
  ) {
    return this.artifacts.revokeTerminalFileGrantsForClient(...args)
  }

  openMobileFile(...args: Parameters<RuntimeFileAccess['openMobileFile']>) {
    return this.access.openMobileFile(...args)
  }

  openMobileDiff(...args: Parameters<RuntimeFileAccess['openMobileDiff']>) {
    return this.access.openMobileDiff(...args)
  }

  listRuntimeMarkdownDocuments(
    ...args: Parameters<RuntimeFileAccess['listRuntimeMarkdownDocuments']>
  ) {
    return this.access.listRuntimeMarkdownDocuments(...args)
  }

  pathsExistRuntimeFiles(...args: Parameters<RuntimeFileAccess['pathsExistRuntimeFiles']>) {
    return this.access.pathsExistRuntimeFiles(...args)
  }

  statRuntimeFile(...args: Parameters<RuntimeFileAccess['statRuntimeFile']>) {
    return this.access.statRuntimeFile(...args)
  }

  readMobileFile(...args: Parameters<RuntimeFileReads['readMobileFile']>) {
    return this.reads.readMobileFile(...args)
  }

  readFileExplorerPreview(...args: Parameters<RuntimeFileReads['readFileExplorerPreview']>) {
    return this.reads.readFileExplorerPreview(...args)
  }

  readDocPreviewFile(...args: Parameters<RuntimeFileReads['readDocPreviewFile']>) {
    return this.reads.readDocPreviewFile(...args)
  }

  readFileExplorerChunk(...args: Parameters<RuntimeFileReads['readFileExplorerChunk']>) {
    return this.reads.readFileExplorerChunk(...args)
  }

  writeFileExplorerFile(...args: Parameters<RuntimeFileMutations['writeFileExplorerFile']>) {
    return this.mutations.writeFileExplorerFile(...args)
  }

  writeFileExplorerFileBase64(
    ...args: Parameters<RuntimeFileMutations['writeFileExplorerFileBase64']>
  ) {
    return this.mutations.writeFileExplorerFileBase64(...args)
  }

  writeFileExplorerFileBase64Chunk(
    ...args: Parameters<RuntimeFileMutations['writeFileExplorerFileBase64Chunk']>
  ) {
    return this.mutations.writeFileExplorerFileBase64Chunk(...args)
  }

  createFileExplorerFile(...args: Parameters<RuntimeFileMutations['createFileExplorerFile']>) {
    return this.mutations.createFileExplorerFile(...args)
  }

  createFileExplorerDir(...args: Parameters<RuntimeFileMutations['createFileExplorerDir']>) {
    return this.mutations.createFileExplorerDir(...args)
  }

  createFileExplorerDirNoClobber(
    ...args: Parameters<RuntimeFileMutations['createFileExplorerDirNoClobber']>
  ) {
    return this.mutations.createFileExplorerDirNoClobber(...args)
  }

  commitFileExplorerUpload(...args: Parameters<RuntimeFileMutations['commitFileExplorerUpload']>) {
    return this.mutations.commitFileExplorerUpload(...args)
  }

  renameFileExplorerPath(...args: Parameters<RuntimeFileMutations['renameFileExplorerPath']>) {
    return this.mutations.renameFileExplorerPath(...args)
  }

  copyFileExplorerPath(...args: Parameters<RuntimeFileMutations['copyFileExplorerPath']>) {
    return this.mutations.copyFileExplorerPath(...args)
  }

  deleteFileExplorerPath(...args: Parameters<RuntimeFileMutations['deleteFileExplorerPath']>) {
    return this.mutations.deleteFileExplorerPath(...args)
  }

  readFileExplorerDir(...args: Parameters<RuntimeFileWatches['readFileExplorerDir']>) {
    return this.watches.readFileExplorerDir(...args)
  }

  watchFileExplorer(...args: Parameters<RuntimeFileWatches['watchFileExplorer']>) {
    return this.watches.watchFileExplorer(...args)
  }

  closeFileExplorerWatchersForPath(
    ...args: Parameters<RuntimeFileWatches['closeFileExplorerWatchersForPath']>
  ) {
    return this.watches.closeFileExplorerWatchersForPath(...args)
  }

  restoreFileExplorerWatchersAfterFailedRemoval(
    ...args: Parameters<RuntimeFileWatches['restoreFileExplorerWatchersAfterFailedRemoval']>
  ) {
    return this.watches.restoreFileExplorerWatchersAfterFailedRemoval(...args)
  }

  forgetFileExplorerWatchersAfterRemoval(
    ...args: Parameters<RuntimeFileWatches['forgetFileExplorerWatchersAfterRemoval']>
  ) {
    return this.watches.forgetFileExplorerWatchersAfterRemoval(...args)
  }

  resolveTerminalPath(...args: Parameters<RuntimeTerminalPathResolver['resolveTerminalPath']>) {
    return this.terminalPaths.resolveTerminalPath(...args)
  }
}
