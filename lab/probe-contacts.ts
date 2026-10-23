import { BasePropertySet, ContactSchema, ItemView, LogicalOperator, PropertySet, SearchFilter, WellKnownFolderName } from "ews-javascript-api"
import { resolveAccounts } from "../src/config"
import { createEwsService } from "../src/ews"
import { installXhrRouter, withAccount } from "../src/xhr-router"

installXhrRouter()
const account = resolveAccounts({ storage: "off" })[0]!
const service = createEwsService(account)
const props = new PropertySet(BasePropertySet.FirstClassProperties, [
  ContactSchema.DisplayName,
  ContactSchema.EmailAddresses,
])

const attempt = async (label: string, filter: SearchFilter.SearchFilterCollection) => {
  try {
    const page = await service.FindItems(WellKnownFolderName.Contacts, filter, new ItemView(5))
    console.log(JSON.stringify({ label, items: page.Items.length, total: page.TotalCount }))
  } catch (error) {
    console.log(JSON.stringify({ label, error: (error as { Message?: string }).Message ?? String(error).slice(0, 120) }))
  }
}

await withAccount({ username: account.username, password: account.password, timeoutMs: account.requestTimeoutMs }, async () => {
  await attempt("displayName", new SearchFilter.SearchFilterCollection(LogicalOperator.Or, [new SearchFilter.ContainsSubstring(ContactSchema.DisplayName, "a")]))
  await attempt(
    "emailAddresses",
    new SearchFilter.SearchFilterCollection(LogicalOperator.Or, [new SearchFilter.ContainsSubstring(ContactSchema.EmailAddresses, "a")]),
  )
  await attempt(
    "both",
    new SearchFilter.SearchFilterCollection(LogicalOperator.Or, [
      new SearchFilter.ContainsSubstring(ContactSchema.DisplayName, "a"),
      new SearchFilter.ContainsSubstring(ContactSchema.EmailAddresses, "a"),
    ]),
  )
  const all = await service.FindItems(WellKnownFolderName.Contacts, new ItemView(5))
  if (all.Items.length > 0) await service.LoadPropertiesForItems(all.Items, props)
  console.log(JSON.stringify({ all: all.Items.length }))
})
