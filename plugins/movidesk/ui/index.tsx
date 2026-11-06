import { defineUiPlugin } from "@/plugins/sdk";

/**
 * Movidesk contributes one task source ("tickets", generic view): the host renders the list, the search, the status filter, the detail
 * sheet and "Open in Movidesk". The source group shows in the Tasks picker only while the plugin is on for the user. While the
 * MOVIDESK_TOKEN secret is missing, the generic view shows the kit's not-configured state with an action that opens Secrets.
 */
export default defineUiPlugin({});
