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

// RFC 4180 allows a quoted line break inside a field, but parseManifestCsv
// splits on newlines before it is quote-aware, so it can never read one back.
// Emitting one would silently split a row in two and hand ingest a phantom
// file_path, so the serializer refuses rather than writing something
// unreadable. A lone \r is just as unsafe: it survives the write and then gets
// eaten by /\r?\n/ on the next read.
const LINE_BREAK_PATTERN = /[\r\n]/;

const quoteCsvValue = (value, context) => {
  const text = String(value ?? "");
  if ( LINE_BREAK_PATTERN.test(text) ) {
    throw new Error(
      `Refusing to serialize ${context}: a manifest value cannot contain a line break (received ${JSON.stringify(text)})`,
    );
  }
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
      MANIFEST_COLUMNS.map((column) =>
        quoteCsvValue(row[column], `${row.file_name || "<unnamed row>"} ${column}`),
      ).join(","),
    ),
  ].join("\n") + "\n";

const isoDate = (date) => date.toISOString().slice(0, 10);

// Task 6's checker scrapes these strings out of HTML, so they arrive
// unnormalised. Refuse control characters at the point of promotion rather
// than letting them reach the manifest, and name the file so the operator
// knows which upstream entry to fix.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const requirePlainUpstreamValue = ({ value, fileName, field }) => {
  if ( CONTROL_CHARACTER_PATTERN.test(value) ) {
    throw new Error(
      `Upstream ${field} for ${fileName} contains a control character; refusing to write it to the manifest (received ${JSON.stringify(value)})`,
    );
  }
  return value;
};

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
    const promote = ({ value, field, fallback }) =>
      value
        ? requirePlainUpstreamValue({ value, fileName: row.file_name, field })
        : fallback;

    return {
      ...row,
      content_sha256: nextSha,
      retrieved_at: isoDate(now),
      pdf_url: promote({
        value: upstream.pdfUrl,
        field: "pdf_url",
        fallback: row.pdf_url,
      }),
      upstream_revision: promote({
        value: upstream.revision,
        field: "upstream_revision",
        fallback: row.upstream_revision,
      }),
    };
  });

  return { rows: nextRows, changed, unchanged };
};
