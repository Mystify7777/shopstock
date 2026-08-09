# ShopStock — Product Requirements Document

**Version:** 1.0  
**Status:** Finalized for initial implementation  
**Product Type:** Lightweight offline-first inventory management application  
**Primary Users:** Small-shop owners and family members with limited technical experience

---

## 1. Product Definition

**ShopStock** is a lightweight, offline-first inventory management application designed to replace a paper stock register for a small physical shop.

The application allows users to:

- Track what products exist
- Track current quantities
- Record stock additions and removals
- Track purchase dates
- Track cost and selling prices
- Calculate expected profit
- Track where products are stored
- Organize products using categories and tags
- Search inventory quickly, including fuzzy search
- Review timestamped stock and product-change history
- Correct mistakes without destroying the audit trail
- Continue working without an internet connection
- Synchronize data when connectivity returns
- Export inventory data for backup or external processing

The application must prioritize **simplicity, reliability, offline availability, and user freedom** over feature density.

---

# 2. Product Philosophy

### Core principle

> The software should impose structure where it helps, but never force the shop owner to think like the software designer.

The application should:

- Be understandable without technical knowledge
- Require minimal interaction for common operations
- Work normally when offline
- Provide sensible defaults without making them mandatory
- Allow users to create their own categories, locations, tags, and units
- Preserve historical information
- Make mistakes recoverable
- Avoid unnecessary enterprise-style features

ShopStock is **not** intended to become:

- A POS system
- An accounting system
- An ERP
- A warehouse management system
- A CRM
- A supplier-management platform
- A business intelligence dashboard

It is a **digital stock register**.

---

# 3. Target Platform

The application is primarily **mobile-first**, because the shop owners are expected to use phones frequently while managing physical stock.

It should also work well on:

- Desktop browsers
- Tablets
- Installed PWA environments

The interface should adapt to larger screens without allowing desktop layouts to dictate the mobile experience.

---

# 4. Core Product Requirements

## 4.1 Product Identity

Every product must have at least one of:

- Product name
- Product photo

The following combination is invalid:

```text
name = empty
photo = empty
```

A product may therefore be:

```text
Name only
Photo only
Name + Photo
```

A photo-only product should remain valid.

---

# 5. Product Data

A product should support:

### Identity

- Name
- One optional photo

### Inventory

- Current quantity
- Unit
- Low-stock threshold

### Pricing

- Latest known cost
- Average known cost
- Selling price
- Configurable default margin
- Calculated current margin
- Suggested selling price

### Classification

- One category
- Multiple locations
- Multiple tags

### Acquisition

- Latest purchase date

### Additional information

- Optional notes

### Metadata

- Created timestamp
- Updated timestamp
- Archive state

---

# 6. Units

The application should provide sensible predefined common units.

Examples:

- Piece
- Packet
- Box
- Bottle
- Dozen
- Kg
- g
- Litre
- ml

Users must also be able to create custom units.

Units must support decimal quantities.

Examples:

```text
2.5 kg
1.75 litres
12 pieces
3.5 boxes
```

The application must not unnecessarily restrict inventory to integers.

---

# 7. Categories

The application should provide a small set of sensible default categories.

Examples:

- Groceries
- Snacks
- Beverages
- Personal Care
- Cleaning
- Stationery
- Other

These are **defaults, not restrictions**.

Users can:

- Add categories
- Rename categories
- Archive categories
- Create completely custom categories

A product can have one category.

If a category is removed from a product, the product falls back to:

> Uncategorized

unless the user chooses to delete the product.

---

# 8. Locations

Products may exist in multiple physical locations.

Example:

```text
Shelf A2
Back Room
```

The product therefore stores locations as an array.

The application should provide default locations such as:

- Counter
- Shelf A1
- Shelf A2
- Back Room
- Other

Users can create custom locations.

Locations can be:

- Added
- Renamed
- Archived

Deleting/removing a location from the system should remove that location from affected products.

If no location remains:

> Location unspecified

The application should not impose hierarchical warehouse structures in V1.

---

# 9. Tags

Tags are reusable, user-defined labels.

Examples:

```text
popular
fast-moving
seasonal
new
fragile
clearance
```

Users can create any tags they want.

Products may contain multiple tags.

Tags can be:

- Added
- Removed from products
- Archived

Deleting a tag removes that tag from affected products.

Tags do not require fallback values.

---

# 10. Classification Deletion

Deleting a category, location, or tag must never silently destroy inventory.

Before deletion, the application must show how many products are affected.

Example:

> 42 products currently use this category.

The user must be able to choose between:

### Remove the field

Affected products remain.

The relevant classification is removed or replaced by its fallback:

- Category → Uncategorized
- Location → Unspecified
- Tag → removed

Other product fields remain untouched.

### Delete selected products

The application lists affected products and allows the user to:

- Select
- Deselect
- Review

Only explicitly selected products are deleted/archived according to the application's destructive-action policy.

The system must never interpret "delete category" as "delete every product using this category" without explicit confirmation.

---

# 11. Stock Management

Stock management uses two simple operations:

```text
+ Add Stock
- Remove Stock
```

The user should not be exposed to complex inventory accounting concepts.

---

## 11.1 Stock Addition

Adding stock records:

- Quantity
- Optional cost per unit
- Purchase date
- Recorded timestamp
- Optional comment

The cost field should automatically be prefilled with the **latest known cost**.

Example:

```text
Latest known cost: ₹55

Cost per unit:
[ ₹55 ]
```

The user may:

- Accept the value
- Change it
- Clear it

If no previous cost exists, the field starts empty.

If the user deliberately clears the cost, the stock addition is recorded without a cost.

---

## 11.2 Purchase Date

Each stock addition has:

```text
purchaseDate
recordedAt
```

`purchaseDate`:

- Defaults to today
- Can be edited by the user

`recordedAt`:

- Automatically generated
- Represents when the action was entered into ShopStock
- Must not be manually altered

Example:

```text
Purchase date: 08 Aug 2026
Recorded:      09 Aug 2026, 3:42 PM
```

---

# 12. Stock Removal

Removing stock requires:

- Quantity

Optional:

- Comment

The system should allow the user to remove more stock than currently available, but must warn them first.

Example:

> Only 5 units are currently available. Remove 8 anyway?

Options:

```text
Cancel
Continue
```

If the comment is empty, the history entry should explicitly display:

> No justification provided

No justification should be invented.

---

# 13. Stock History

Every stock addition and removal must create a permanent timestamped history event.

Example:

```text
09 Aug 2026 · 3:42 PM
+20 stock
Comment: New delivery

08 Aug 2026 · 6:13 PM
-3 stock
Comment: Sold

07 Aug 2026 · 2:17 PM
-1 stock
No justification provided
```

Stock history must contain:

- Product ID
- Operation type
- Quantity
- Timestamp
- Purchase date when applicable
- Cost when applicable
- Optional comment
- Reversal relationship when applicable

Stock history entries must not be silently deleted.

---

# 14. Undo

After a stock addition/removal, show a temporary toast for approximately 5 seconds.

Example:

```text
Stock reduced by 2

[ Undo ]
```

If Undo is pressed:

- Reverse the operation
- Preserve the original history entry
- Create the corresponding reversal event

Undo must not physically erase the original event.

---

# 15. Historical Reversal

A historical stock event can be reversed later.

Example:

```text
−8
Removed stock
08 Aug · 4:32 PM

[ Reverse this action ]
```

The system creates a compensating event:

```text
+8
Reversal of previous stock removal
09 Aug · 1:18 PM
```

The original and reversal events should reference each other.

History must therefore remain an honest record of what actually happened.

---

# 16. Product Change History

Product metadata changes should be recorded separately from stock history.

Examples:

```text
Selling price changed
Category changed
Location changed
Name changed
Tags changed
```

This history exists so users can understand important changes without digging through stock operations.

The two histories remain separate:

```text
Stock History
Product Change History
```

---

# 17. Cost Tracking

The system should support multiple recorded cost points without exposing batch-accounting complexity to the user.

For stock additions with cost:

```text
20 × ₹50
10 × ₹55
```

The application calculates:

### Latest cost

```text
₹55
```

### Average known cost

```text
(20×50 + 10×55) / 30
= ₹51.67
```

Stock additions without a recorded cost are excluded from the average-cost calculation.

The UI should make clear when the average is based on only part of the current inventory.

Example:

> Average cost: ₹51.67  
> Based on 30 of 35 units with recorded cost

---

# 18. Estimated Cost for Unknown Stock

For calculations that require a cost for units whose actual cost is unknown, the system may use the **latest known cost as an estimate**.

This must be clearly labelled as estimated.

The application must distinguish:

- Recorded cost
- Estimated cost

It must never silently represent an estimate as historical fact.

---

# 19. Selling Price

Each product has a manually controlled selling price.

The selling price is authoritative.

The system may suggest a new price based on:

- Current/average cost
- Product margin configuration

But the system must never automatically change the selling price.

---

# 20. Margin

There is a configurable default margin.

Each product can override the global default.

Example:

```text
Default margin: 20%

Product override: 25%
```

The system can use the configured margin to calculate a suggested selling price.

After the user manually sets or accepts a selling price, the application recalculates the actual margin.

Therefore:

> The configured margin is a suggestion mechanism, not the authoritative financial state.

---

# 21. Selling Price Review

When the cost changes enough to make the existing selling price potentially unsuitable, the application may show:

> Selling price may need review.

Example:

```text
Current cost: ₹60
Current selling price: ₹65
Suggested price: ₹72

[ Accept ₹72 ]
[ Keep ₹65 ]
```

Rejecting the suggestion leaves the existing selling price unchanged.

---

# 22. Low Stock

Each product has a low-stock threshold.

There is a global default threshold.

Individual products may override it.

Example:

```text
Default: 5

Product:
Low-stock threshold → 10
```

A product may also disable low-stock warnings.

The application should distinguish:

```text
Normal
Low Stock
Out of Stock
```

---

# 23. Search

Search is a primary feature.

It must search across:

- Product name
- Category
- Tags
- Locations
- Notes

Search should be:

- Local-first
- Fast
- Fuzzy
- Debounced approximately 400–500 ms
- Case-insensitive

Search should provide useful results even when the query is imperfect.

Example:

```text
Query:
parleg
```

can return:

```text
Parle-G
Parle Marie
```

---

# 24. Related Search Results

When no exact match exists, the application should show:

### Closest matches

Based on fuzzy text similarity.

### Related products

Based on:

- Category
- Shared tags
- Location
- Other relevant searchable metadata

Example:

```text
No exact matches for "parleg"

Closest matches
Parle-G
Parle Marie

Related products
Good Day
Bourbon
Hide & Seek
```

Search must not depend on an external AI service.

---

# 25. Search Filters

Users should be able to combine filters.

Examples:

```text
Search: biscuit

Category: Snacks
Location: Shelf A
Tag: Popular
```

Filters should be presented as compact controls, not a large filter panel.

Mobile convenience is the priority.

---

# 26. Voice Search

Voice search is an enhancement, not a dependency.

The search UI may include:

```text
🔍 Search
🎤
```

Voice input should populate the normal search field and use the same search engine.

If browser/device support is unavailable, normal text search remains fully functional.

No paid external voice-search service should be required.

---

# 27. Product Photos

Each product supports at most one photo in V1.

Supported inputs:

- Device camera
- Device file/photo upload

Photos should be compressed and optimized.

Because the application is offline-first, client-side compression should occur before local storage/synchronization where practical.

Server-side optimization may also be used as a secondary layer.

---

# 28. Dashboard

The dashboard must remain clean.

It should prioritize:

- Search
- Add Product
- Add Stock
- Important stock warnings
- Recently updated products
- Useful summary numbers

Potential summary information:

```text
Total Products
Total Units
Low Stock
Out of Stock
Inventory Cost
Expected Selling Value
Expected Profit
```

Archived products should not be included in normal dashboard totals.

The dashboard must avoid unnecessary charts and analytics.

---

# 29. Recently Updated

The dashboard should show recently changed inventory.

Example:

```text
Recently Updated

Parle-G       −3
Good Day      +20
Dettol        −1
```

This should be more prominent than decorative analytics.

---

# 30. Offline-First Architecture

The application must remain usable without an internet connection.

The local application is the primary operational data source.

Conceptually:

```text
UI
 ↓
Application Services
 ↓
Local Repository
 ↓
IndexedDB
 ↓
Sync Queue
 ↓
API
 ↓
MongoDB
```

Normal reads should come from local storage.

Normal writes should:

1. Update local state immediately
2. Update the UI immediately
3. Create a synchronization operation
4. Sync to the server when possible

Internet connectivity must not be required for normal inventory management.

---

# 31. Synchronization

When offline:

```text
User action
 ↓
IndexedDB
 ↓
Sync queue
```

When connectivity returns:

```text
Sync queue
 ↓
API
 ↓
MongoDB
 ↓
Success
 ↓
Queue item resolved
```

Stock additions and removals are independent events.

Example:

```text
Device A: +5
Device B: -2
```

Result:

```text
Net change: +3
```

Stock operations should not use destructive last-write-wins replacement.

---

# 32. Field Conflict Resolution

For direct metadata conflicts, use timestamp-based last-write-wins.

Example:

```text
Phone:
Selling price → ₹60
10:03 AM

Laptop:
Selling price → ₹65
10:07 AM
```

Result:

```text
Selling price = ₹65
```

The earlier change should remain represented in product-change history.

---

# 33. Authentication

The application uses a **single account**.

There is no V1 requirement for:

- Multiple users
- Roles
- Permissions
- Staff management
- Organization management

However, the application should have a username/password login so that a publicly accessible application does not expose inventory immediately to anyone who opens the URL.

Authentication must be real server-side authentication, not merely a frontend visibility lock.

---

# 34. Trusted Devices

Once a device has successfully authenticated, it should remain trusted.

The user should not need to repeatedly enter their credentials.

The application should use a secure persistent session/token mechanism.

The plaintext password must never be stored in localStorage.

A device that has already been authenticated should remain usable offline.

A new device requires authentication before accessing the shop data.

---

# 35. Password Changes

If the account password is changed or revoked:

- Existing trusted devices may continue using local data while offline
- On reconnection, they should be required to authenticate again before further synchronization

This avoids silently trusting indefinitely revoked sessions.

---

# 36. Export

The application should support:

### JSON

Canonical structured export for backup and future restoration.

Should contain:

- Products
- Categories
- Locations
- Tags
- Units
- Stock history
- Product change history
- Settings

Photos are **not included in V1 JSON export**.

### CSV

Human-readable inventory export.

Useful for:

- Excel
- LibreOffice
- Google Sheets
- External processing

---

# 37. Future Backup Format

A future release may support:

```text
ShopStock Backup.zip

├── data.json
└── images/
```

This is intentionally outside V1.

---

# 38. PDF

PDF generation is intentionally deferred.

The structured JSON/CSV data model should make it possible for a future parser/report generator to produce formatted reports such as:

- Inventory report
- Stock history report
- Category report
- Profit report

PDF generation should not contaminate the core inventory model.

---

# 39. Deferred Features

The following are explicitly outside V1:

- Barcode scanning
- QR scanning
- Multiple photos per product
- Multiple user accounts
- Roles and permissions
- Supplier management
- Purchase invoices
- POS functionality
- Sales accounting
- Advanced analytics
- AI inventory forecasting
- Automated selling-price changes
- PDF generation
- Cloud image backup
- Hierarchical warehouse locations

The architecture should not prevent these features from being added later, but V1 should not implement them.

---

# 40. Non-Functional Requirements

### Simplicity

Common operations should require minimal interaction.

### Performance

Search and local inventory operations should feel immediate.

### Offline reliability

Core inventory operations must work without network connectivity.

### Data integrity

Historical stock events must not be silently destroyed.

### Recoverability

Accidental stock operations must be reversible.

### User freedom

Defaults should assist rather than constrain.

### Mobile-first

The primary interface must work comfortably on a phone.

### Zero-cost target

The initial architecture should target ₹0/month infrastructure cost using free-tier services where practical.

The application should avoid dependencies on paid APIs for core functionality.

---

# 41. Suggested Technology Direction

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
- Mongoose or native MongoDB driver

### Search

- Local fuzzy-search implementation such as Fuse.js

### Authentication

- Server-side authentication
- Secure persistent session/token

### Database

- MongoDB Atlas free tier initially

The exact library choices may be adjusted during implementation if a materially better lightweight alternative exists.

---

# 42. V1 Success Criteria

ShopStock is successful when a non-technical shop owner can:

1. Add a product in under a minute
2. Find an existing product quickly
3. Add or remove stock in a few interactions
4. Understand current stock immediately
5. See where the product is stored
6. Understand its cost and selling price
7. See expected profit
8. Correct accidental stock changes
9. Review what happened and when
10. Continue using the application without internet
11. Recover synchronization later
12. Export their data
13. Create their own categories, locations, tags, and units without developer intervention

The application should feel closer to a **digital notebook with reliable structure** than an enterprise inventory platform.

---

# 43. Product Boundary

The central question ShopStock must answer is:

> **"What do we have, how much do we have, what did it cost, what do we sell it for, and where is it?"**

If a proposed feature does not materially improve that workflow, it should not automatically enter V1.