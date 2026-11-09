export function compileTopic(input: {
  topic: { id: string; title: string; projectId: string }
  sources: { logicalId: string; packetId: string; revision: string; title: string; text: string }[]
}): { body: string; evidenceCount: number }
