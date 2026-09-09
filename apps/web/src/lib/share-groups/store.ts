// Back-compat shim. The Facebook-group row became a general marketing
// COMMUNITY in D-125; the CRUD rules moved to lib/marketing/communities.ts
// alongside the rest of the acquisition system. This module keeps the old
// import path and the old narrow view alive so callers that only ever needed
// "id, name, url" — the social-preview panel, the growth checklist, the mobile
// share-groups route — did not have to change in the same commit.
//
// New code should import from @/lib/marketing/communities.

import {
  addCommunity,
  communityInputSchema,
  COMMUNITY_NAME_MAX,
  COMMUNITY_URL_MAX,
  countCommunities,
  deleteCommunity,
  listCommunities,
  updateCommunity,
  type CommunityInput,
} from "@/lib/marketing/communities";

export const SHARE_GROUP_NAME_MAX = COMMUNITY_NAME_MAX;
export const SHARE_GROUP_URL_MAX = COMMUNITY_URL_MAX;

export const shareGroupInputSchema = communityInputSchema;
export type ShareGroupInput = CommunityInput;

export type ShareGroupView = {
  id: string;
  name: string;
  url: string | null;
};

export async function listShareGroups(teacherId: string): Promise<ShareGroupView[]> {
  const rows = await listCommunities(teacherId);
  return rows.map((r) => ({ id: r.id, name: r.name, url: r.url }));
}

export const countShareGroups = countCommunities;

export async function addShareGroup(
  teacherId: string,
  input: ShareGroupInput,
): Promise<ShareGroupView> {
  const created = await addCommunity(teacherId, input);
  return { id: created.id, name: created.name, url: created.url };
}

export const updateShareGroup = updateCommunity;
export const deleteShareGroup = deleteCommunity;
