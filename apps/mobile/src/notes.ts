import type { NoteDocument } from "@vidscribe/shared";

export function formatTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function markdownForDocument(document: NoteDocument): string {
  const lines = [
    `# ${document.video.title}`,
    "",
    `Duration: ${formatTimestamp(document.video.duration)}`,
    `Generated: ${new Date(document.generatedAt).toLocaleString()}`,
    ""
  ];

  for (const section of document.sections) {
    lines.push(`## [${formatTimestamp(section.startSeconds)}] ${section.title}`);
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    for (const definition of section.definitions) {
      lines.push(`- Definition: ${definition.term} - ${definition.explanation}`);
    }
    for (const example of section.examples) {
      lines.push(`- Example: ${example}`);
    }
    if (section.visual) {
      lines.push(`- Visual: ${section.visual}`);
    }
    lines.push("");
  }

  if (document.warnings.length > 0) {
    lines.push("## Warnings");
    for (const warning of document.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}
