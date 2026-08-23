export const MANIFEST_COLUMNS = [
  "file_name",
  "title_hint",
  "source_type",
  "source_group",
  "chapter_ref",
  "priority",
  "file_path",
  "source_url",
  "pdf_url",
  "content_sha256",
  "retrieved_at",
  "upstream_revision",
];

const splitCsvLine = (line) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for ( let index = 0; index < line.length; index += 1 ) {
    const char = line[index];
    if ( char === '"' ) {
      if ( inQuotes && line[index + 1] === '"' ) {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if ( char === "," && !inQuotes ) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
};

const quoteCsvValue = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const parseManifestCsv = (text) => {
  const [headerLine, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(headerLine);

  return lines.map((line) => {
    const values = splitCsvLine(line);
    return headers.reduce(
      (record, header, index) => ({ ...record, [header]: values[index] || "" }),
      {},
    );
  });
};

export const serializeManifestCsv = (rows) =>
  [
    MANIFEST_COLUMNS.join(","),
    ...rows.map((row) =>
      MANIFEST_COLUMNS.map((column) => quoteCsvValue(row[column])).join(","),
    ),
  ].join("\n") + "\n";

const isoDate = (date) => date.toISOString().slice(0, 10);

export const planManifestRefresh = ({ rows, hashes, upstreamState, now }) => {
  const changed = [];
  let unchanged = 0;

  const nextRows = rows.map((row) => {
    const nextSha = hashes[row.file_path];
    if ( !nextSha ) {
      throw new Error(
        `Local file missing for manifest row ${row.file_name} (${row.file_path})`,
      );
    }
    if ( nextSha === row.content_sha256 ) {
      unchanged += 1;
      return row;
    }

    changed.push({
      fileName: row.file_name,
      previousSha: row.content_sha256,
      nextSha,
    });

    const upstream = upstreamState?.entries?.[row.file_name] || {};
    return {
      ...row,
      content_sha256: nextSha,
      retrieved_at: isoDate(now),
      pdf_url: upstream.pdfUrl || row.pdf_url,
      upstream_revision: upstream.revision || row.upstream_revision,
    };
  });

  return { rows: nextRows, changed, unchanged };
};
