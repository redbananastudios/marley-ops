# Pitmans import templates — gate 20

Four CSVs, four importers. These files are both the **column contract** and the
**sheets to send Mark**: each one carries realistic example rows so the shape is
obvious without reading a spec. Delete the examples before importing, or leave
them in a dry run to see how they render.

The full column documentation lives at the top of each importer script, not
here, so it cannot drift from the code that reads it.

| Template | Importer | Creates |
|---|---|---|
| `pitmans-staff-template.csv` | `scripts/import-pitmans-staff.mjs` | staff rows (not logins) |
| `pitmans-vehicles-template.csv` | `scripts/import-pitmans-vehicles.mjs` | vehicles, with livery brand |
| `pitmans-bookings-template.csv` | `scripts/import-pitmans-bookings.mjs` | client → lead → quote → removal appointment |
| `pitmans-storage-template.csv` | `scripts/import-pitmans-storage.mjs` | site → unit → client → storage let |

## Run them in this order

Staff and vehicles first. They are independent of everything else, they are the
smallest sheets, and having the fleet and crew in place means an imported
booking can be allocated the moment somebody looks at it.

Bookings and storage after, in either order. Both create clients, and both match
an existing client by email or phone before creating one — so a customer who has
both a removal and a storage unit ends up as **one** client with both, whichever
import runs first.

## Every importer works the same way

```bash
# 1. Plan. Writes nothing. This is the output to read carefully.
node --env-file=.env.local scripts/import-pitmans-bookings.mjs sheet.csv

# 2. Write, to staging or a local Supabase.
node --env-file=.env.local scripts/import-pitmans-bookings.mjs sheet.csv --commit

# 3. Write to PRODUCTION — needs the extra flag, and is Peter's to run.
node --env-file=/opt/marley-ops/app.env scripts/import-pitmans-bookings.mjs sheet.csv --commit --prod

# 4. Undo one batch.
node --env-file=.env.local scripts/import-pitmans-bookings.mjs --rollback <batch> --commit
```

- **Dry run is the default.** Nothing is written without `--commit`.
- **Validation is all-or-nothing.** A single bad cell aborts the whole sheet with
  a line-numbered list, before anything is written. Fix the sheet and re-run.
- **Re-running is safe.** Each importer skips what it has already imported and
  says why, so a corrected sheet can be re-run without duplicating the rows that
  were already fine.
- **`--batch <label>`** names the batch; it defaults to a dated one. The label is
  what `--rollback` takes.
- **Rollback refuses** when real work has attached — money, signatures, crew
  allocations, pay lines. It tells you what is blocking rather than cascading a
  delete through a customer's history.

## Things worth knowing before the real run

**Imported bookings are silent.** They import with `source = 'pitmans'`, which
puts them behind `legacyLocked()` (`lib/legacy.ts`): no chases, no commitment
invoicing, no T-7 final invoice. These customers were sold by Mark under his
terms and have never heard from Marley, so the first contact from the new owner
must not be an automated payment demand. The office lifts it per booking with the
standard-comms switch on the lead page, **after** phoning the customer.

**Imported storage lets do not bill** until somebody unpauses them from
`/storage`. Pass `--billing-live` only when the figures have been checked.

**References are minted, not copied.** A booking gets a fresh `PMR###`/`PMC###`
from the database; Mark's own reference is kept in `quotes.legacy_ref` for
reconciliation against his paperwork. A rollback does **not** return the minted
references to the counter — reissuing one could put the same reference on a
second customer's paperwork, so a rolled-back batch leaves a gap in the sequence.

**Import to staging first and have Mark check it against the paper diary**
(PRD §5, 21–28 September), then re-run the same sheet against production.

**The brand must exist and should be active before the prod import.** Importing
into an inactive brand works — the importer says so and continues — but the rows
render unbadged, in Marley colours, until `brands.pitmans.active` is true. The
PRD's cutover order is deliberate: activate, then import.
