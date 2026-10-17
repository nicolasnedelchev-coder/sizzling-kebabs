// Netlify function: creates a Stripe Checkout page for the basket.
// Prices come from this list, never from the browser, so a customer can't change them.
const PRICES = {
  "Koobideh Kebab": 12.00,
  "Chicken Shish": 12.00,
  "Lamb Shish": 15.00,
  "Double Shish": 13.00,
  "Special Kebab": 19.00,
  "Barg Kebab": 16.00,
  "Soltani Kebab": 16.00,
  "Barbecue Ribs": 19.00,
  "Chicken Wings": 9.00,
  "Charcoal Chicken": 12.00,
  "Whole Chicken Kebab": 11.00,
  "Lamb Doner": 9.00,
  "Chicken Doner": 8.50,
  "Mixed Doner": 9.00,
  "Sea Bass": 14.00,
  "Salmon": 15.00,
  "Sea Bream": 14.00,
  "Prawns": 14.00,
  "Tashreeb": 14.00,
  "Kabuli Pulao": 13.00,
  "Fries": 2.50,
  "Tacco Chips": 4.00,
  "Taco Cheese Chips": 5.00,
  "Cheese Chips": 4.00,
  "Garlic Cheese Chips": 5.00,
  "Curry Chips": 3.50,
  "Curry Cheese Chips": 3.50,
  "Halloumi Cheese Salad": 6.00,
  "Hummus": 2.00,
  "Tzatziki": 2.00,
  "Shirazi Salad": 2.50,
  "Mousir": 2.50,
  "Single Beef Burger": 4.50,
  "Double Beef Burger": 6.00,
  "Special Beef Burger": 8.50,
  "Chicken Fillet Burger": 4.50,
  "Fish Burger": 4.50,
  "Chicken Doner Burger": 7.50,
  "Lamb Doner Burger": 8.00,
  "Mixed Doner Burger": 8.00,
  "Chicken Tenders": 7.50,
  "Chicken Nuggets": 7.50,
  "Ghoozi": 15.00,
  "Zereshk Polo with Chicken": 11.00,
  "Ghormeh Sabzi": 11.00,
  "Fresh Falafel": 7.00,
  "Lahmacun": 9.00,
  "Kumpir Potato": 10.00,
  "Coca-Cola": 1.50,
  "Coca-Cola Zero": 1.50,
  "Fanta": 1.50,
  "Water": 1.50,
  "Ayran": 1.50,
  "7UP": 1.50,
  "Sprite": 1.50,
  "Capri-Sun": 1.00,
  "Garlic Sauce": 0.00,
  "Chilli Sauce": 0.00
};
const DELIVERY_FEE_PENCE = Number(process.env.DELIVERY_FEE_PENCE || 0);

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  if (!process.env.STRIPE_SECRET_KEY) return reply(500, { error: "Card payments are not set up yet" });

  let order;
  try {
    order = JSON.parse(event.body || "{}");
  } catch (err) {
    return reply(400, { error: "Bad request" });
  }

  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0 || items.length > 50) return reply(400, { error: "Your basket is empty" });

  const lines = [];
  for (const item of items) {
    const price = PRICES[item.name];
    const qty = Number(item.qty);
    if (price === undefined || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      return reply(400, { error: "One of the dishes is not valid" });
    }
    lines.push({ name: item.name, pence: Math.round(price * 100), qty });
  }

  // Free items (such as sauces) are not charged; Stripe needs every charged line to be above zero
  const paid = lines.filter((l) => l.pence > 0);
  if (paid.length === 0) return reply(400, { error: "Please add a dish to pay by card" });

  const isDelivery = order.type === "delivery";
  const clean = (s, max) => String(s || "").trim().slice(0, max);
  if (isDelivery && (!clean(order.address, 200) || !clean(order.postcode, 20))) {
    return reply(400, { error: "Please add your address and postcode for delivery" });
  }

  const base = "https://" + event.headers.host;
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", base + "/?paid=1");
  params.append("cancel_url", base + "/?cancelled=1#order");

  let i = 0;
  for (const l of paid) {
    params.append(`line_items[${i}][quantity]`, String(l.qty));
    params.append(`line_items[${i}][price_data][currency]`, "gbp");
    params.append(`line_items[${i}][price_data][unit_amount]`, String(l.pence));
    params.append(`line_items[${i}][price_data][product_data][name]`, l.name);
    i++;
  }
  if (isDelivery && DELIVERY_FEE_PENCE > 0) {
    params.append(`line_items[${i}][quantity]`, "1");
    params.append(`line_items[${i}][price_data][currency]`, "gbp");
    params.append(`line_items[${i}][price_data][unit_amount]`, String(DELIVERY_FEE_PENCE));
    params.append(`line_items[${i}][price_data][product_data][name]`, "Delivery");
  }

  params.append("metadata[order_type]", isDelivery ? "delivery" : "pickup");
  params.append("metadata[customer_name]", clean(order.name, 100));
  params.append("metadata[customer_phone]", clean(order.phone, 40));
  params.append("metadata[address]", isDelivery ? clean(order.address + ", " + order.postcode, 300) : "");
  params.append("metadata[notes]", clean(order.notes, 400));
  params.append("metadata[basket]", clean(lines.map((l) => l.qty + " x " + l.name).join(", "), 480));

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const session = await res.json();
    if (!res.ok || !session.url) {
      console.error("Stripe error:", session.error && session.error.message);
      return reply(502, { error: "Payment could not start" });
    }
    return reply(200, { url: session.url });
  } catch (err) {
    console.error("Stripe request failed:", err.message);
    return reply(502, { error: "Payment could not start" });
  }
};