# Digital Music Stand Definition of Done

All items in this checklist are required for release. There are no optional or roadmap-only items in this document.

## 1. Release Gate

- [ ] The stand can be opened from supported member UI entry points without requiring a direct URL.
- [ ] The stand can be opened from supported admin or director workflows used to manage event music.
- [ ] The stand renders successfully for a valid authorized user on desktop and tablet breakpoints.
- [ ] The stand fails safely with a non-crashing error state when required data is missing or corrupt.
- [ ] Every required stand API route responds with validated contracts and production-safe error handling.
- [ ] The feature has passed the required validation, QA, and regression checks listed in this document.

## 2. Access Control and Security

- [ ] `/member/stand/[eventId]` requires an authenticated authorized user.
- [ ] Unauthorized event access returns a non-enumerable response path.
- [ ] Stand PDF access is only available through authenticated stand proxy routes.
- [ ] PDF proxy routes verify that the requested file belongs to music assigned to the event in scope.
- [ ] Annotation APIs enforce visibility and write permissions for PERSONAL, SECTION, and DIRECTOR layers.
- [ ] Smart Nav APIs enforce create, update, and delete permissions for privileged roles only.
- [ ] Audio link APIs enforce create, update, and delete permissions for privileged roles only.
- [ ] Bookmarks only expose the current user’s bookmark records.
- [ ] Setlists only expose records allowed by the current ownership and permission policy.
- [ ] Sync and presence endpoints require stand access before returning state, presence, or annotations.
- [ ] Every stand endpoint validates request payloads and returns consistent 400, 403, 404, and 500 behavior.

## 3. Event Music and Part Resolution

- [ ] Event music loads in the intended program order.
- [ ] Every event piece resolves a valid default PDF or produces a clear unavailable state.
- [ ] Part switching loads the correct authenticated PDF route for the selected part.
- [ ] Member part overrides persist and reload correctly.
- [ ] Full score fallback works when a part-specific PDF is not available.
- [ ] Changing pieces resets navigation state safely and predictably.

## 4. Viewer and Navigation Core

- [ ] The current piece and current page are initialized correctly on load.
- [ ] PDF rendering works with valid page counts and does not trap the user on the first page.
- [ ] Next and previous page actions honor piece boundaries.
- [ ] Setlist advancement moves to the next piece at the end of the current piece.
- [ ] Reverse setlist navigation moves to the previous piece from the first page when appropriate.
- [ ] Fullscreen mode works without hiding critical recovery controls.
- [ ] Night mode applies consistently across the viewer experience.
- [ ] Gig or performance mode removes non-essential visual distractions without breaking core use.
- [ ] Keyboard, gesture, and MIDI page navigation do not conflict with each other in normal use.

## 5. Annotation System

- [ ] PERSONAL, SECTION, and DIRECTOR annotations load correctly from persisted data.
- [ ] Legacy annotation payloads are normalized so previously saved marks still render.
- [ ] Freehand pencil annotations render, persist, and reload correctly.
- [ ] Highlighter annotations render, persist, and reload correctly.
- [ ] Eraser behavior removes marks from the active editable layer only.
- [ ] Whiteout annotations render and persist correctly.
- [ ] Text annotations render, persist, and reload correctly.
- [ ] Stamp annotations render, persist, and reload correctly.
- [ ] Undo and redo behave predictably during active annotation sessions.
- [ ] Layer selection in the UI reflects actual role permissions.
- [ ] Forbidden layer writes are rejected by the API even if the client is bypassed.
- [ ] Saving annotations does not silently corrupt `strokeData` shape.
- [ ] Reloading the stand after annotation changes preserves the expected visible state.

## 6. Smart Nav

- [ ] Existing Smart Nav hotspots load for the current piece and page.
- [ ] Smart Nav hotspots navigate to the correct destination page.
- [ ] Cross-piece Smart Nav links navigate to the correct destination piece when configured.
- [ ] Smart Nav create uses the same request and response contract on client and server.
- [ ] Smart Nav update uses the same request and response contract on client and server.
- [ ] Smart Nav delete uses the implemented route shape and only removes the hotspot locally after a successful server response.
- [ ] Smart Nav edit controls are shown only to roles allowed to manage navigation links.
- [ ] Smart Nav hotspots remain keyboard accessible in view mode.

## 7. Bookmarks

- [ ] The bookmarks panel loads the current user’s bookmarks successfully.
- [ ] Bookmark creation works for the current piece from the stand UI.
- [ ] Bookmark removal calls the implemented API contract and removes the correct record.
- [ ] Bookmark refresh works without duplicating or corrupting the local list.
- [ ] Opening a bookmark jumps to the intended piece in the stand.
- [ ] Bookmark error states are visible to the user when requests fail.

## 8. Setlists

- [ ] The setlists panel loads the setlists available to the current user under the implemented permission model.
- [ ] Setlist creation uses the implemented API contract and refreshes the list correctly.
- [ ] Setlist deletion uses the implemented API contract and removes the correct record.
- [ ] Expanded setlist views show the expected ordered pieces.
- [ ] Empty-state and error-state handling are visible and accurate.
- [ ] UI capability gating matches the allowed create and delete policy.

## 9. Audio Links and Playback

- [ ] Audio links load correctly for the current piece.
- [ ] Audio link creation works from the stand UI.
- [ ] Audio link editing works from the stand UI.
- [ ] Audio link deletion works from the stand UI.
- [ ] Audio link playback uses the authenticated proxy path required by the backend.
- [ ] Audio links remain scoped to the correct piece after navigation changes.

## 10. Practice Tracking

- [ ] The practice timer can start, stop, and save a session successfully.
- [ ] Saved practice sessions reload correctly in the stand UI.
- [ ] Practice duration fields remain aligned between client and server contracts.
- [ ] Practice log deletion removes the intended session.
- [ ] Practice log access is limited to authorized users and pieces.

## 11. Real-Time Sync and Presence

- [ ] Polling fallback keeps stand presence alive for active users.
- [ ] Leaving the stand clears polling presence cleanly.
- [ ] Active roster data is internally consistent between count and list responses.
- [ ] Presence updates add and remove members correctly in the stand roster.
- [ ] Sync state can carry current page, current piece index, and night mode without contract drift.
- [ ] The viewer applies incoming sync state instead of silently ignoring it.
- [ ] The viewer applies incoming command messages for page, piece, and night mode changes.
- [ ] Polling sync fetches recent shared annotations for the current piece.
- [ ] Shared annotation updates merge into the local stand state without duplicating records.
- [ ] PERSONAL annotations are never surfaced to other users through sync paths.
- [ ] Polling and websocket modes behave consistently enough that changing transport does not change user-facing correctness.

## 12. Reliability and Error Handling

- [ ] A viewer-level error boundary protects the stand from child component crashes.
- [ ] Failed Smart Nav, bookmark, setlist, audio, practice, and annotation actions fail with visible or logged feedback.
- [ ] Missing PDFs, missing event music, and missing related stand data produce non-crashing fallback states.
- [ ] API handlers avoid silent success when contract parsing fails.
- [ ] Permission failures are distinguishable from missing-resource failures where the product expects them to be.

## 13. Accessibility and UX Safety

- [ ] Interactive stand controls have accessible labels.
- [ ] Keyboard navigation works for primary stand actions and panel interactions.
- [ ] The stand remains usable in reduced-motion environments.
- [ ] Color and contrast choices remain legible in both regular and night modes.
- [ ] Panel and overlay interactions do not block critical navigation paths unexpectedly.

## 14. Observability and Supportability

- [ ] Stand load failures are logged with enough context to debug the failure path.
- [ ] Annotation save failures are logged with enough context to debug the failure path.
- [ ] Sync failures are logged with enough context to debug the failure path.
- [ ] Permission-sensitive failures can be distinguished during support and incident review.
- [ ] The current production operating notes and developer docs match the implemented behavior.

## 15. Validation and QA Requirements

- [ ] Authorization coverage exists for stand page access and stand file proxy access.
- [ ] Annotation coverage exists for visibility, write permissions, and persistence contracts.
- [ ] Smart Nav coverage exists for create, update, delete, and navigation behavior.
- [ ] Audio link coverage exists for create, update, delete, and load behavior.
- [ ] Practice log coverage exists for create, read, and delete behavior.
- [ ] Sync coverage exists for state updates, presence, and shared annotation polling behavior.
- [ ] Manual QA has verified the complete member flow for open stand, navigate music, annotate, bookmark, use setlists, manage audio, and log practice.
- [ ] Manual QA has verified the complete privileged flow for Smart Nav management, audio management, and shared annotation behavior.
- [ ] Any remaining known limitation is documented outside this DoD and is not required for this release gate.
