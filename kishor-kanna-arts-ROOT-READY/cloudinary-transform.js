// cloudinary-transform.js
//
// Thin wrapper around two Cloudinary AI add-ons:
//   - Background Removal  (effect: background_removal)
//   - AI Upscale           (effect: upscale)
//
// Both add-ons must be enabled on the Cloudinary account (Add-ons page in
// the Cloudinary console — Background Removal and AI Upscale both have a
// free tier, but they're opt-in). If they're not enabled, Cloudinary will
// return a 4xx and the functions below will throw with that message.
//
// This module assumes `cloudinary.config(...)` has already run — server.js
// does that before requiring this file, and the `cloudinary` npm package
// caches its config as a singleton, so no need to configure it again here.

const cloudinary = require('cloudinary').v2;

// Pull the Cloudinary public_id (folder/filename, no extension, no version)
// back out of a secure_url like:
//   https://res.cloudinary.com/<cloud>/image/upload/v169.../kishor-kanna-arts/artworks/abc123.jpg
// -> "kishor-kanna-arts/artworks/abc123"
function extractPublicId(secureUrl) {
  if (!secureUrl) return null;
  const match = secureUrl.match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  return match ? match[1] : null;
}

// Builds the on-the-fly transformed delivery URL, then re-uploads that URL
// as a brand new Cloudinary asset so the result is a permanent, stable
// secure_url (rather than a transformation string we'd have to keep re-
// applying every time the image is displayed).
async function bakeTransformation(imageUrl, transformOptions, folder) {
  const publicId = extractPublicId(imageUrl);
  if (!publicId) {
    throw new Error('Could not determine the Cloudinary public ID from this image URL — is it a Cloudinary-hosted image?');
  }
  const transformedUrl = cloudinary.url(publicId, { secure: true, ...transformOptions });
  const result = await cloudinary.uploader.upload(transformedUrl, {
    folder: `kishor-kanna-arts/${folder}`
  });
  return result.secure_url;
}

// Removes the background from an artwork photo. Output is a PNG so the
// transparency is preserved.
async function removeBackground(imageUrl, folder = 'artworks') {
  return bakeTransformation(imageUrl, { effect: 'background_removal', format: 'png' }, folder);
}

// AI-upscales (and lightly sharpens) a blurry/low-res reference photo.
async function upscaleImage(imageUrl, folder = 'artworks') {
  return bakeTransformation(imageUrl, { effect: 'upscale' }, folder);
}

module.exports = { extractPublicId, bakeTransformation, removeBackground, upscaleImage };
