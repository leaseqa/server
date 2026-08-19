import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const PLAIN_TEXT_EXTENSIONS = new Set([".txt", ".md", ".text"]);
const DOCX_EXTENSIONS = new Set([".docx"]);
const PDF_EXTENSIONS = new Set([".pdf"]);

const normalizeText = (value) =>
  value
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const ensureNonEmpty = (text, sourceName) => {
  const normalized = normalizeText(text);
  if ( !normalized ) {
    throw new Error(`No readable text found in ${sourceName}`);
  }
  return normalized;
};

const parsePdfBuffer = async (buffer, sourceName) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return ensureNonEmpty(result.text || "", sourceName);
  } finally {
    await parser.destroy();
  }
};

const parseDocxBuffer = async (buffer, sourceName) => {
  const result = await mammoth.extractRawText({ buffer });
  return ensureNonEmpty(result.value || "", sourceName);
};

const parsePlainTextBuffer = (buffer, sourceName) =>
  ensureNonEmpty(buffer.toString("utf-8"), sourceName);

const getExtension = (sourceName) =>
  path.extname(sourceName || "").toLowerCase();

export const extractTextFromUpload = async ({
                                              buffer,
                                              originalName,
                                              mimeType,
                                            }) => {
  const extension = getExtension(originalName);
  if ( PDF_EXTENSIONS.has(extension) || mimeType === "application/pdf" ) {
    return parsePdfBuffer(buffer, originalName);
  }
  if (
    DOCX_EXTENSIONS.has(extension) ||
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return parseDocxBuffer(buffer, originalName);
  }
  if ( PLAIN_TEXT_EXTENSIONS.has(extension) || mimeType?.startsWith("text/") ) {
    return parsePlainTextBuffer(buffer, originalName);
  }
  if ( extension === ".doc" ) {
    throw new Error(
      "Legacy .doc files are not supported yet. Please export as .docx or PDF.",
    );
  }
  throw new Error(
    `Unsupported file type: ${originalName || mimeType || "unknown file"}`,
  );
};

export const extractCorpusPages = async (
  { buffer, originalName, mimeType },
  { PDFParseClass = PDFParse } = {},
) => {
  const extension = getExtension(originalName);
  if ( PDF_EXTENSIONS.has(extension) || mimeType === "application/pdf" ) {
    const parser = new PDFParseClass({ data: buffer });
    try {
      const result = await parser.getText();
      const pages = (result.pages || [])
        .map((page) => ({
          text: normalizeText(page.text || ""),
          pageNumber: page.num,
        }))
        .filter((page) => page.text.length > 0);
      if ( pages.length === 0 ) {
        ensureNonEmpty("", originalName);
      }
      return pages;
    } finally {
      await parser.destroy();
    }
  }

  return [
    {
      text: await extractTextFromUpload({ buffer, originalName, mimeType }),
      pageNumber: null,
    },
  ];
};

export const extractTextFromFilePath = async (filePath) => {
  const buffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  return extractTextFromUpload({
    buffer,
    originalName: fileName,
    mimeType: undefined,
  });
};

export const splitTextToChunks = async ({
                                          text,
                                          metadata,
                                          chunkSize,
                                          chunkOverlap,
                                        }) => {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });
  return splitter.createDocuments([text], [metadata]);
};

export const createTextPreview = (text, maxLength = 240) => {
  const compact = text.replace(/\s+/g, " ").trim();
  if ( compact.length <= maxLength ) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}...`;
};
