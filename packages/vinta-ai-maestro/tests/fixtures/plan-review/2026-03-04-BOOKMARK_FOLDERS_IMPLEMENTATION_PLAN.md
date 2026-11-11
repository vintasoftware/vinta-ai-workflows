# Bookmark Folders — Implementation Plan

Synthetic fixture for the plan-review tests. It pairs with
`plan-feature-example.workflow.json`, whose `prompt_ref` anchors name the
headings below.

## 1. Goals

1. Users can group bookmarks into folders.
2. Folders nest, up to five levels deep.
3. The folder tree loads in one request.

Non-goals:

- Sharing folders between users.
- Drag-and-drop reordering.

## 2. Guiding Decisions

| Decision | Resolution |
|---|---|
| **Storage shape** | A `BookmarkFolder` table with a self-FK `parent`. Adjacency list, because trees stay shallow. |
| **Feature flag** | `bookmark-folders`, per-tenant, default off. Flip on after Phase 4 soaks for a week on staging. |
| **Depth limit** | Five levels, enforced in the serializer so the error names the field. |

## 3. Data Model Changes

### 3.1 New BookmarkFolder

```python
class BookmarkFolder(TenantModel):
    name = models.CharField(max_length=120)
    parent = models.ForeignKey("self", null=True, on_delete=models.CASCADE)
```

## 4. API Design

### 4.1 Folders

`GET /api/folders` returns the tree. `POST /api/folders` creates one.

## 5. Phased Rollout

### Phase 1 — BookmarkFolder model + migration

**Goal**: the table exists and nothing reads it yet.

**Depends on**: nothing — starts from the base branch.

Changes:
1. `apps/bookmarks/models.py`: add `BookmarkFolder`.
2. A migration creating the table.

Tests:
- **Unit**: `apps/bookmarks/tests/test_models.py` — the self-FK cascades.

Acceptance: `manage.py migrate` creates `bookmarks_bookmarkfolder`.

### Phase 2 — Folder CRUD endpoints

**Goal**: folders can be created, renamed and deleted through the API.

**Depends on**: Phase 1 (the `BookmarkFolder` model and its migration).

**Feature flag**: `bookmark-folders` — off returns 404 from every folder route.

Changes:
1. `apps/bookmarks/views.py`: a `FolderViewSet` mirroring `TagViewSet`.

Tests:
- **Integration**: `apps/bookmarks/tests/test_folder_api.py` — CRUD, plus flag-off returns 404.

Acceptance: `POST /api/folders` returns 201 with the flag on.

### Phase 3 — Folder tree serializer

**Goal**: one serializer renders a folder and its descendants.

**Depends on**: Phase 1 (the `BookmarkFolder.parent` self-FK the tree is walked over).

Changes:
1. `apps/bookmarks/serializers.py`: `FolderTreeSerializer`, depth-limited to five.

Tests:
- **Unit**: `apps/bookmarks/tests/test_tree.py` — six levels deep is rejected.

Acceptance: a five-level tree serializes in one query.

### Phase 4 — Nested folder listing endpoint

**Goal**: `GET /api/folders` returns the whole tree.

**Depends on**: Phase 2 (the `/api/folders` viewset this list action is added to), Phase 3 (the `FolderTreeSerializer` payload shape).

Changes:
1. `apps/bookmarks/views.py`: the `list` action returns `FolderTreeSerializer` output.

Tests:
- **Integration**: `apps/bookmarks/tests/test_folder_api.py` — the tree payload.

Acceptance: the tree loads in one request.

### Phase 5 — Remove the `bookmark-folders` feature flag

**Goal**: folders are unconditional.

**Depends on**: Phase 2, Phase 3, Phase 4.

Changes:
1. Delete the flag and its off-branches.

Acceptance: `grep -r "bookmark-folders" apps/` returns nothing.

## 6. Risk & Rollout Notes

The migration only creates a table, so it takes no lock on existing ones.

## 7. Open Questions

- Should deleting a folder move its bookmarks to the parent? Recommended default: yes.

## 8. Touch List

- Phase 1: `apps/bookmarks/models.py`, a new migration.
- Phase 2–4: `apps/bookmarks/views.py`, `apps/bookmarks/serializers.py`.
