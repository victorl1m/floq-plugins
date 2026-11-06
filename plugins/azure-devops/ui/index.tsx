import { defineUiPlugin } from "@/plugins/sdk";

/**
 * Azure DevOps contributes one task source ("items", generic view): work items from a WIQL query. The host renders the list and
 * shows the kit's not-configured state while the AZURE_DEVOPS_PAT secret or the organization/project settings are missing.
 */
export default defineUiPlugin({});
