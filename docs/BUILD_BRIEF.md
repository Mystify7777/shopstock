# ShopStock — Claude Build Brief

You are building **ShopStock**, a lightweight offline-first inventory management application for a small physical shop.

The attached/preceding PRD is the **product source of truth**.

Your job is to implement the application faithfully. Do not reinterpret the product into a larger inventory-management platform.

---

# 1. Core Product Intent

ShopStock is a:

> **simple digital stock register for a small physical shop**

The primary users are non-technical family members.

The application must therefore optimize for:

- Simplicity
- Mobile-first UX
- Fast common operations
- Offline availability
- Clear information
- Recoverable mistakes
- User-defined classifications
- Minimal cognitive load

Do not introduce enterprise features unless explicitly requested.

Do not turn this into StockSphere.

---

# 2. Critical Architectural Principle

The application is **offline-first**, not merely "offline-capable."

The normal application flow must be:

```text
UI
 ↓
Application/domain services
 ↓
Local persistence
 ↓
IndexedDB
 ↓
Sync queue
 ↓
API
 ↓
MongoDB
```

The server must not be required for ordinary reads and writes after a device has been authenticated.

A user must be able to:

- Browse inventory
- Search
- Add products
- Edit products
- Add stock
- Remove stock
- Review history
- Undo/reverse operations

while offline.

Network synchronization happens afterward.

---

# 3. Before Writing Code

Do NOT immediately generate the whole application.

First:

1. Inspect the repository.
2. Inspect the existing project structure.
3. Identify existing reusable code/configuration.
4. Determine whether the repository is empty or already contains a scaffold.
5. Propose the final architecture.
6. Define the domain model.
7. Define the IndexedDB schema.
8. Define the MongoDB schema.
9. Define the synchronization/event model.
10. Define authentication/session behavior.
11. Define the frontend routing/component structure.
12. Define the implementation phases.

Then begin implementation in small, verifiable stages.

Do not make large speculative changes before validating the architecture.

---

# 4. Technology Constraints

Preferred stack:

### Frontend

- React
- Vite
- JavaScript
- PWA
- IndexedDB

### Backend

- Node.js
- Express
- MongoDB

### Search

Use a lightweight client-side fuzzy-search solution such as Fuse.js unless there is a compelling reason not to.

### Database

MongoDB Atlas should be supported.

### Language

Use JavaScript.

Do not migrate the project to TypeScript unless explicitly instructed.

---

# 5. Domain Model

The initial domain should include:

```text
Product
Category
Location
Tag
Unit
StockEvent
ProductChangeEvent
User/Account
```

Products should conceptually contain:

```text
Product
├── identity
│   ├── name?
│   └── photo?
│
├── inventory
│   ├── quantity
│   ├── unit
│   └── lowStockThreshold
│
├── pricing
│   ├── latestCost
│   ├── averageKnownCost
│   ├── sellingPrice
│   └── marginConfiguration
│
├── classification
│   ├── categoryId?
│   ├── locationIds[]
│   └── tagIds[]
│
├── acquisition
│   └── latestPurchaseDate?
│
├── notes?
└── metadata
```

Do not blindly copy this structure if a better implementation is required, but preserve the product semantics.

---

# 6. Product Identity Rule

A product is valid if:

```text
name exists
OR
photo exists
```

It is invalid if:

```text
name is empty
AND
photo is empty
```

A photo-only product is valid.

---

# 7. User-Managed Reference Data

Categories, locations, tags, and units must not be hardcoded enums.

Provide sensible defaults, but allow users to:

- Create
- Rename
- Archive
- Reuse

their own values.

Defaults are starting points, not restrictions.

---

# 8. Categories

One category per product.

Deletion must not silently destroy products.

Removing a category from a product should result in:

```text
Uncategorized
```

unless the user explicitly chooses to delete selected affected products.

---

# 9. Locations

Products support multiple locations.

Use an array/reference model.

Example:

```text
locationIds: [
  shelfA2,
  backRoom
]
```

Deleting one location removes only that location from affected products.

If no locations remain:

```text
Unspecified
```

Do not implement hierarchical warehouse locations in V1.

---

# 10. Tags

Tags are reusable free-form labels.

Products may have multiple tags.

Deleting a tag removes it from products.

There is no fallback tag.

---

# 11. Classification Deletion UX

When deleting a category/location/tag:

1. Identify affected products.
2. Show the number of affected products.
3. Explain what will happen.
4. Allow the user to remove the field while retaining products.
5. If product deletion is selected, show the affected products.
6. Allow individual selection/deselection.
7. Require explicit confirmation before destructive deletion.

Never silently cascade-delete products.

---

# 12. Stock Model

Stock changes must be represented as events.

Core operations:

```text
ADD
REMOVE
```

Stock events should contain enough information to preserve an audit trail.

At minimum:

```text
id
productId
type
quantity
timestamp
purchaseDate?
costPerUnit?
comment?
reversalOf?
reversedBy?
sync metadata
```

Stock events should not be physically deleted as part of normal application behavior.

---

# 13. Stock Addition

The stock-add form should contain:

```text
Quantity
Cost per unit
Purchase date
Comment
```

### Cost behavior

If a latest known cost exists:

```text
Cost per unit = latest known cost
```

as the initial form value.

The user may:

- Accept it
- Change it
- Clear it

If cleared, the event has unknown cost.

If no known cost exists, the field starts empty.

Do not silently replace a deliberately cleared cost with another value.

---

# 14. Purchase Date

Every stock addition has:

```text
purchaseDate
recordedAt
```

`purchaseDate` defaults to the current date but is editable.

`recordedAt` is automatic and immutable.

These values must remain distinct.

---

# 15. Cost Calculations

Maintain:

### Latest known cost

The most recent stock-addition cost that exists.

### Average known cost

Weighted average of stock additions for which cost was recorded.

Example:

```text
20 × ₹50
10 × ₹55
5 × unknown
```

Average known cost:

```text
₹51.67
```

based on 30 known-cost units.

Unknown-cost additions must not silently become known-cost inventory.

For estimates where a cost is required, latest known cost may be used as an explicitly labelled estimate.

---

# 16. Selling Price

The manually set selling price is authoritative.

The application may calculate a suggested selling price based on:

- Current/average cost
- Configured margin

But never automatically overwrite the selling price.

The user must explicitly accept a suggestion.

---

# 17. Margin

Provide:

```text
Global default margin
Product-specific override
```

The actual displayed margin should be recalculated from the manually accepted/current selling price.

The configured margin is used for suggestions, not as the authoritative result.

---

# 18. Stock Removal

The user should only need to specify:

```text
Quantity
Comment (optional)
```

If removing more than available:

```text
Warning:
Only X units are available.
Continue?
```

Allow the user to continue.

If the comment is empty, history should show:

```text
No justification provided
```

---

# 19. Undo

After every stock mutation, provide a roughly five-second toast:

```text
Stock updated

[Undo]
```

Undo must create a compensating operation rather than erase history.

The original event must remain available.

---

# 20. Historical Reversal

Every stock history item should be capable of being reversed later.

Reversal creates a new compensating event.

Example:

```text
Original:
-8

Reversal:
+8
```

Link the two events.

Never erase the original event.

---

# 21. Product Change History

Keep metadata changes separate from stock history.

Track important changes such as:

- Name
- Category
- Location
- Tags
- Selling price
- Relevant pricing configuration

The UI should expose separate:

```text
Stock History
Product Change History
```

This separation is intentional.

---

# 22. Search

Search must operate locally over the indexed product data.

Search:

- Name
- Category
- Tags
- Locations
- Notes

Use fuzzy matching.

Debounce approximately:

```text
400–500 ms
```

Search must remain responsive on mobile.

Use weighted fields so product-name matches rank above incidental note matches.

---

# 23. Search Suggestions

When there is no exact result:

1. Show closest fuzzy matches.
2. Show related products.
3. Use category, tags, and location to improve recommendations.

Do not call an external AI API.

Search must work offline.

---

# 24. Filters

Support combined filtering.

Example:

```text
Search: biscuit
Category: Snacks
Location: Shelf A2
Tag: popular
```

The filter UI must be mobile-friendly.

Do not create a giant filter sidebar or full-screen form for simple filtering.

Use compact controls such as:

```text
[Category] [Location] [Tags] [More]
```

where appropriate.

---

# 25. Voice Search

Voice search is optional enhancement functionality.

If browser/device speech recognition is supported:

```text
voice input
 ↓
search field
 ↓
normal fuzzy search
```

If unavailable, text search must continue normally.

Do not make voice search a core dependency.

Do not add a paid speech API.

---

# 26. Photos

V1 supports:

- One photo per product
- Camera input
- Device upload

No multi-photo gallery.

Images should be compressed before local storage where practical.

Server-side optimization can be used as an additional layer.

Do not make remote image storage a requirement for local operation.

---

# 27. Dashboard

Keep the dashboard intentionally simple.

Prioritize:

- Search
- Add Product
- Add Stock
- Low-stock warnings
- Out-of-stock warnings
- Recently updated products
- Useful inventory totals

Potential metrics:

```text
Total Products
Total Units
Low Stock
Out of Stock
Inventory Cost
Expected Selling Value
Expected Profit
```

Do not add decorative charts merely because dashboards traditionally contain charts.

---

# 28. Archive Behavior

Products should normally be archived rather than immediately deleted.

Archived products:

- Do not appear in normal inventory
- Do not contribute to normal dashboard totals
- Retain historical information

Permanent deletion should be deliberately destructive and protected by confirmation.

---

# 29. IndexedDB Architecture

Use IndexedDB as the primary local data store.

Separate concerns between:

```text
Domain/application logic
Local repository
IndexedDB adapter
Sync queue
Remote API
```

Avoid scattering IndexedDB calls throughout React components.

The UI should not know how data is persisted.

---

# 30. Sync Architecture

All mutations should have local-first behavior:

```text
User action
 ↓
Validate
 ↓
Update local database
 ↓
Update UI
 ↓
Create sync operation
 ↓
Attempt server synchronization
```

If offline:

```text
Keep queued
```

When online:

```text
Retry queued operations
```

The sync engine should be idempotent where practical.

Duplicate delivery of the same operation must not accidentally apply the stock mutation twice.

---

# 31. Conflict Handling

Stock operations are additive/subtractive events.

They should not overwrite one another.

Example:

```text
Device A: +5
Device B: -2
```

Result:

```text
Net +3
```

For direct metadata conflicts, use timestamp-based last-write-wins.

Example:

```text
Phone:
price = ₹60
10:03

Desktop:
price = ₹65
10:07
```

Final:

```text
₹65
```

The earlier change should remain visible through product-change history.

---

# 32. Authentication

Use a single shop account.

Required:

- Username
- Password
- Server-side authentication

Not required:

- Roles
- Permissions
- Multiple users
- Staff management

Do not store the plaintext password in localStorage.

Use a secure persistent authentication mechanism.

---

# 33. Trusted Device / Offline Authentication

After successful authentication:

```text
Device becomes trusted
```

The user should not need to log in repeatedly.

A trusted device can continue using the application offline.

A new device must authenticate before accessing the shop account.

Password changes should invalidate/revoke remote sessions appropriately.

---

# 34. Export

Provide:

### JSON

Complete structured data export excluding photos in V1.

### CSV

Inventory table suitable for spreadsheet applications.

Export must be generated locally where practical so that export works offline.

---

# 35. Future-Proofing

Do not implement yet:

- Barcode scanning
- Multiple photos
- PDF
- Supplier management
- POS
- Multiple accounts
- Advanced analytics
- AI forecasting

However, do not design the core data model in a way that makes these future additions impossible.

---

# 36. UI/UX Requirements

Mobile-first.

Common operations should be reachable with minimal taps.

Prefer:

- Large touch targets
- Clear labels
- Obvious primary actions
- Compact filters
- Simple cards
- Bottom navigation where appropriate
- Clear empty states
- Clear success/error feedback
- Confirmation only where destructive actions require it

Avoid:

- Dense enterprise tables on mobile
- Excessive modal chains
- Hidden actions
- Technical terminology
- Unnecessary configuration
- Decorative dashboards
- Excessive animations

---

# 37. Validation

Validation should be human-readable.

Bad:

```text
INVALID_FIELD_37
```

Good:

> Product needs a name or photo.

Good:

> Quantity must be greater than 0.

Good:

> Only 5 units are available. You entered 8.

---

# 38. Testing Requirements

Do not rely only on manual testing.

At minimum, test:

### Domain logic

- Product validation
- Cost calculations
- Margin calculations
- Suggested selling price
- Low-stock calculation
- Stock addition
- Stock removal
- Over-removal warning
- Reversal
- Undo
- Average-cost calculation
- Unknown-cost handling

### Search

- Exact search
- Fuzzy search
- Weighted ranking
- Combined filters
- Empty results
- Related results

### Offline

- Local reads
- Local writes
- Queued mutations
- Sync recovery
- Duplicate sync protection

### Data integrity

- History preservation
- Reversal relationships
- Archive behavior
- Classification deletion behavior

### Authentication

- Login
- Session persistence
- Offline trusted-device access
- Session invalidation

---

# 39. Implementation Strategy

Build in phases.

## Phase 1 — Foundation

- Repository structure
- Frontend/backend setup
- Environment configuration
- MongoDB connection
- Basic API structure
- IndexedDB abstraction
- PWA foundation

## Phase 2 — Domain Model

Implement:

- Product
- Category
- Location
- Tag
- Unit
- StockEvent
- ProductChangeEvent

Write domain tests.

## Phase 3 — Local Inventory

Implement:

- Product CRUD
- Local persistence
- Product list
- Product detail
- Add/edit product
- Categories
- Locations
- Tags
- Units

Everything should work locally before sync is added.

## Phase 4 — Stock Operations

Implement:

- Add stock
- Remove stock
- Cost tracking
- Purchase dates
- Comments
- Stock history
- Undo
- Reversal

## Phase 5 — Search

Implement:

- Search indexing
- Debouncing
- Fuzzy search
- Filters
- Related results

## Phase 6 — Synchronization

Implement:

- Mutation queue
- Server persistence
- Retry
- Idempotency
- Conflict resolution
- Sync status

## Phase 7 — Authentication

Implement:

- Single account
- Login
- Persistent session
- Trusted-device behavior
- Offline access
- Session invalidation

## Phase 8 — Dashboard and UX Polish

Implement:

- Dashboard
- Low-stock indicators
- Recently updated
- Important CTAs
- Empty states
- Mobile polish

## Phase 9 — Export

Implement:

- JSON export
- CSV export

## Phase 10 — Hardening

Run:

- Full test suite
- Production build
- Offline tests
- Sync tests
- Mobile layout review
- Accessibility review
- Error-state review
- Data integrity review

---

# 40. Engineering Rules

### Rule 1

Do not over-engineer.

### Rule 2

Do not introduce abstractions without a concrete reason.

### Rule 3

Keep the domain logic independent of React components.

### Rule 4

Keep persistence logic behind repositories/adapters.

### Rule 5

Never make server availability a requirement for normal offline operations.

### Rule 6

Never destroy history to make a correction.

### Rule 7

Never silently invent financial data.

### Rule 8

Defaults assist the user but must not restrict them.

### Rule 9

Do not add features merely because they are technically interesting.

### Rule 10

Do not modify the product requirements without explicitly identifying the requirement being changed and why.

---

# 41. First Task

Your first response should NOT be a giant code dump.

Instead:

1. Inspect the repository.
2. Summarize the current state.
3. Identify whether existing code can be reused.
4. Propose the final project structure.
5. Propose the domain model.
6. Propose the IndexedDB schema.
7. Propose the MongoDB schema.
8. Propose the sync-event format.
9. Explain authentication/session architecture.
10. Identify any conflicts or ambiguities in this specification.
11. Provide the implementation sequence.
12. Wait for architectural approval before making large-scale implementation changes.

The PRD above is the source of truth.

If a requirement seems unnecessarily complex, explain the concern and propose a simpler alternative **before changing it**.

Do not silently simplify away a requirement.

Do not silently expand scope.

Build the smallest system that satisfies the specification correctly.