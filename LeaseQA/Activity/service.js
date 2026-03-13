export const buildActivity = ({
  userId,
  type,
  title,
  summary = "",
  href = "",
  surface = "account",
  metadata = {},
}) => ({
  userId,
  type,
  title,
  summary,
  href,
  surface,
  metadata,
});
