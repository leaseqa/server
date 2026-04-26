export function collectDiscussionAuthorIds(nodes = []) {
  const ids = [];
  const stack = [...nodes];

  while ( stack.length > 0 ) {
    const node = stack.pop();
    if ( !node ) continue;

    if ( node.authorId ) {
      ids.push(node.authorId);
    }

    if ( Array.isArray(node.replies) && node.replies.length > 0 ) {
      stack.push(...node.replies);
    }
  }

  return ids;
}

export function annotateDiscussionTreeAuthors(nodes = [], userMap = {}) {
  return nodes.map((node) => {
    const discussion = node.toObject ? node.toObject() : node;

    return {
      ...discussion,
      author: userMap[discussion.authorId?.toString()] || null,
      replies: annotateDiscussionTreeAuthors(discussion.replies || [], userMap),
    };
  });
}

export function collectDiscussionSubtreeIds(nodes = [], rootId) {
  if ( !rootId ) return [];

  const normalizedRootId = rootId.toString();
  const byParent = new Map();

  nodes.forEach((node) => {
    const parentKey = node.parentId ? node.parentId.toString() : null;
    const bucket = byParent.get(parentKey) || [];
    bucket.push(node);
    byParent.set(parentKey, bucket);
  });

  const ids = [];
  const stack = [normalizedRootId];

  while ( stack.length > 0 ) {
    const currentId = stack.pop();
    if ( !currentId || ids.includes(currentId) ) continue;

    ids.push(currentId);
    const children = byParent.get(currentId) || [];
    children.forEach((child) => {
      stack.push(child._id.toString());
    });
  }

  return ids;
}
