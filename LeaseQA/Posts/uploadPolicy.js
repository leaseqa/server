import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXTENSION = new Map([
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
]);

const uploadsEnabled = (env, isProduction) => {
  if ( env.UPLOADS_ENABLED === undefined ) {
    return !isProduction;
  }
  if ( env.UPLOADS_ENABLED === true || env.UPLOADS_ENABLED === "true" ) {
    return true;
  }
  if ( env.UPLOADS_ENABLED === false || env.UPLOADS_ENABLED === "false" ) {
    return false;
  }
  throw new Error("UPLOADS_ENABLED must be true or false.");
};

const disabledPolicy = {
  enabled: false,
  storageRoot: null,
  array: () => (_req, _res, next) => {
    const error = new Error("Attachment uploads are disabled.");
    error.code = "UPLOADS_DISABLED";
    next(error);
  },
  serve: (_req, _res, next) => next(),
};

export const createAttachmentUpload = (env = process.env) => {
  const environment = env.SERVER_ENV || env.NODE_ENV || "development";
  const isProduction = environment === "production";
  const enabled = uploadsEnabled(env, isProduction);

  if ( !enabled ) {
    return disabledPolicy;
  }

  if ( isProduction && !env.UPLOADS_DIR ) {
    throw new Error("UPLOADS_DIR is required when uploads are enabled in production.");
  }

  if ( env.UPLOADS_DIR && !path.isAbsolute(env.UPLOADS_DIR) ) {
    throw new Error("UPLOADS_DIR must be an absolute path.");
  }

  const storageRoot = env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
  fs.mkdirSync(storageRoot, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, storageRoot),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${randomUUID()}${extension}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_ATTACHMENT_BYTES },
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if ( MIME_BY_EXTENSION.get(extension) !== file.mimetype ) {
        const error = new Error("Unsupported attachment type.");
        error.code = "UNSUPPORTED_ATTACHMENT_TYPE";
        callback(error);
        return;
      }
      callback(null, true);
    },
  });

  return {
    enabled: true,
    storageRoot,
    array: upload.array.bind(upload),
    serve: express.static(storageRoot, {
      setHeaders: (res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    }),
  };
};
