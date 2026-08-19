import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "b",
  "i",
  "blockquote",
  "code",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "a",
];

const isAllowedLink = (href) => /^(?:https?:\/\/|mailto:)/i.test(href.trim());

export const sanitizeRichText = (html) => sanitizeHtml(
  typeof html === "string" ? html : "",
  {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => {
        const href = typeof attribs.href === "string" ? attribs.href : "";
        return {
          tagName: "a",
          attribs: {
            ...(isAllowedLink(href) ? { href: href.trim() } : {}),
            ...(typeof attribs.title === "string" ? { title: attribs.title } : {}),
          },
        };
      },
    },
  },
);
