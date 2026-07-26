// referral.js
// Referral + wallet rewards system.
//
// How it works:
//   1. Every customer gets a unique referral_code the moment they sign up.
//   2. They share a link like  https://yoursite.in/account/signup?ref=CODE
//   3. A friend who signs up through that link is linked to them
//      (customer.referred_by = referrer's id) and a row is added to the
//      `referrals` collection with status 'pending'.
//   4. When that friend's FIRST order is marked "Delivered" in the admin
//      panel, the referrer is credited a wallet reward (see
//      referral_reward_amount in Settings) and the referral row is marked
//      'rewarded'. The referred friend also gets an automatic discount on
//      their first order (see referral_discount_percent in Settings).
//   5. Wallet balance can be redeemed against any future order.
//
// This file is intentionally self-contained (same pattern as mailer.js /
// notify.js) so it can be required from server.js with a single line.

const db = require('./db');
const mailer = require('./mailer');

// ---------- Settings (with sensible defaults if admin hasn't set them) ----------
async function getReferralSettings() {
  const s = await db.getAllSettings();
  return {
    rewardAmount: parseFloat(s.referral_reward_amount || '200'),
    discountPercent: parseFloat(s.referral_discount_percent || '10')
  };
}

// ---------- Referral code generation ----------
function makeCandidateCode(name) {
  const base = String(name || 'FRIEND').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'FRND';
  const rand = Math.floor(1000 + Math.random() * 9000); // 4 digits
  return `${base}${rand}`;
}

// Generates a referral code that isn't already in use. Extremely unlikely to
// collide (4 letters + 4 digits), but we check anyway since it must be unique.
async function generateUniqueReferralCode(name) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = makeCandidateCode(name);
    const existing = await db.findOne('customers', { referral_code: code });
    if (!existing) return code;
  }
  // Fallback: timestamp-based, effectively guaranteed unique.
  return `FRND${Date.now().toString().slice(-6)}`;
}

// ---------- Linking a new signup to whoever referred them ----------
// Call this right after a new customer account is created. `refCode` is
// whatever came in on ?ref=CODE (signup page) or the referral form field.
async function linkReferralIfAny(newCustomer, refCode) {
  if (!refCode) return;
  const referrer = await db.findOne('customers', { referral_code: String(refCode).trim().toUpperCase() });
  if (!referrer || referrer._id.toString() === newCustomer.id) return; // no self-referrals

  await db.updateById('customers', newCustomer.id, { referred_by: referrer._id.toString() });
  await db.insertOne('referrals', {
    referrer_id: referrer._id.toString(),
    referred_id: newCustomer.id,
    referred_name: newCustomer.name,
    referred_email: newCustomer.email,
    status: 'pending',
    rewarded_at: null
  });
}

// ---------- Discount for the referred customer's first order ----------
// Returns 0 if not eligible (not referred, or already placed an order before).
async function getFirstOrderDiscountPercent(customer) {
  if (!customer || !customer.referred_by) return 0;
  const priorOrders = await db.count('orders', { customer_id: customer.id });
  if (priorOrders > 0) return 0;
  const { discountPercent } = await getReferralSettings();
  return discountPercent;
}

// ---------- Crediting the referrer once the referred friend's order is delivered ----------
// Call this whenever an order's status is changed to "Delivered".
async function rewardIfEligible(customerId) {
  if (!customerId) return;
  const pending = db.normalize(await db.findOne('referrals', { referred_id: customerId, status: 'pending' }));
  if (!pending) return; // this customer wasn't referred, or was already rewarded

  const { rewardAmount } = await getReferralSettings();
  const referrer = db.normalize(await db.findById('customers', pending.referrer_id));
  if (!referrer) return;

  const newBalance = (referrer.wallet_balance || 0) + rewardAmount;
  await db.updateById('customers', referrer.id, { wallet_balance: newBalance });
  await db.updateById('referrals', pending.id, { status: 'rewarded', rewarded_at: new Date().toISOString() });

  if (referrer.email) {
    const s = await db.getAllSettings();
    mailer.sendMail({
      to: referrer.email,
      subject: `You earned ₹${rewardAmount} in ${s.site_name} wallet credit! 🎉`,
      html: `Hi ${referrer.name},<br><br>Great news — your friend ${pending.referred_name || ''} just received their first order, ` +
        `so we've added <b>₹${rewardAmount}</b> to your ${s.site_name} wallet.<br><br>` +
        `Use it on your next order — just tick "Use my wallet balance" at checkout.<br><br>— ${s.site_name}`
    });
  }
}

// ---------- Wallet redemption at checkout ----------
// Given the customer and the price after coupon/referral discount, works out
// how much wallet balance can actually be used (never more than they have,
// never more than the order is worth).
function calcWalletRedemption(customer, priceAfterDiscount, wantsToUseWallet) {
  if (!customer || !wantsToUseWallet || !priceAfterDiscount) return 0;
  const available = customer.wallet_balance || 0;
  return Math.max(0, Math.min(available, priceAfterDiscount));
}

module.exports = {
  getReferralSettings,
  generateUniqueReferralCode,
  linkReferralIfAny,
  getFirstOrderDiscountPercent,
  rewardIfEligible,
  calcWalletRedemption
};
