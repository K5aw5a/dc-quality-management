# Private pages

Some project information is kept **outside this repository** because the repository is public. It lives on private claude.ai pages that only the owner can open (until the owner shares them from the page's **Share** menu). This note lists those pages and how each one is kept up to date.

None of their content is stored here, and none should be: no audit notes, client names, action lists or exported records.

| Page | What it is | How it is updated |
| --- | --- | --- |
| [Quality audit record](https://claude.ai/artifact/NxtZuXvePSmLAm7RQM9aTR) | Record of the quality audits: for each audit, the preparation checklist, the audit areas (what to say, what to show, gaps, questions to ask), findings and the resulting action list with owners, dates and status. | **Through chat only.** Tell Claude what changed (e.g. "ITP date is 15 Dec", "findings were …", or upload the action list). Claude updates and republishes the page. The page has no edit controls. |

## Copy inside the app

The **Audits** page in the app shows the same audit record:

1. When the record changes, Claude also produces an updated `audit-record.json` in the chat.
2. Upload that file on the app's **Upload** page. The Audits page shows the latest version; earlier uploads are kept as versions.

The JSON file is uploaded into the app's local data folder. Never commit it to this repository.

## Adding a page

When a new private page is created, add a row to the table above: its name (generic, without client or project names), its link, one line on what it holds, and how it is updated.
