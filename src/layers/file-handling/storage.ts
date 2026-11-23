import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FileInfo {
  path: string
  content: string
}

export async function readFile(filePath: string): Promise<FileInfo> {
  const content = await fs.promises.readFile(filePath, 'utf-8')
  return { path: filePath, content }
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.promises.writeFile(filePath, content)
}

export async function listDirectory(dirPath: string): Promise<string[]> {
  return await fs.promises.readdir(dirPath)
}