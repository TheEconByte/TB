type Owned = { userId: string } | null;

export function owns(resource: Owned, userId: string) {
  return resource !== null && resource.userId === userId;
}
