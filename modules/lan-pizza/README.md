# LAN party pizza orders

Collect food orders for a group pizza run. **No payment provider or takeaway service is connected.** Members place
orders on the site, pay an organiser in cash, organisers tick payments off and phone the order in from an automatic
shopping list, then announce when the food arrives.

## How a pizza run works

1. An organiser starts a **pizza run** (name, optional order deadline, notes such as which shop and where to
   collect).
2. Members pick quantities from the **menu** (pizzas, sides, drinks, desserts, with vegetarian and vegan labels) and
   add notes ("no olives", allergies). The page shows a live total. Members can change or cancel their order until
   orders close **or** until it has been paid.
3. Members bring cash. An organiser clicks **Received £X** next to their order, and the member is notified. Payments
   can be undone, and every payment change is in the audit log.
4. **Close orders** stops new orders and reminds anyone unpaid. The **shopping list** totals every item, split into
   paid and not-yet-paid orders, so organisers order what has been paid for.
5. **Mark as ordered**, then **Food has arrived** notifies everyone with an order. Organisers tick **Handed out** as
   people collect.

Prices are copied onto each order when it's placed, so later menu edits don't change what people owe.

## Pages

- `/m/lan-pizza`: current runs, the menu and order form, and your order with its payment status
- Admin › Pizza runs: start runs, step through the statuses, shopping list, cash collected and outstanding, orders
  with Received / Handed out / Remove
- Admin › Pizza runs › Edit the menu: add items, change prices, hide items, load an example menu
- **LAN intranet widget:** add `pizza` to the intranet's sections to show the current run, deadline and order count

| Permission | Default | Lets you |
| --- | --- | --- |
| `lan-pizza.view` | guests, members | see pizza runs and the menu |
| `lan-pizza.order` | members | place an order |
| `lan-pizza.handle` | administrators | take cash payments and mark food handed out (good for helpers on the desk) |
| `lan-pizza.manage` | administrators | start runs, change their status, remove orders, edit the menu |

## Settings

- **Currency symbol**: default `£`.
- **How to pay**: text shown to everyone with an unpaid order.

## Limits and privacy

- One order per member per run (editing replaces it), up to 10 of each item and 20 different items.
- 30 order changes per hour per member.
- Closing an account deletes that member's unpaid orders. Paid orders are kept as a cash record.
- **Data:** `mod_lan_pizza_rounds`, `mod_lan_pizza_menu`, `mod_lan_pizza_orders`, `mod_lan_pizza_items`.
- **Notifications:** `lan-pizza` (payment received, orders closed while unpaid, food arrived). Members can turn
  these off.
- **Exposes** `currentSummary()` (used by `lan-intranet`).
