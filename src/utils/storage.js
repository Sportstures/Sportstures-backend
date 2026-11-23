// Image storage on Cloudinary. Needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.
// STORAGE_DRIVER is optional; when set it must be "cloudinary". CLOUDINARY_FOLDER (default "sportstures")
// keeps this app's files apart from anything else in the same Cloudinary account.
const cloudinary = require('cloudinary').v2;

let configured = false;

function isConfigured() {
  const driver = (process.env.STORAGE_DRIVER || 'cloudinary').toLowerCase();
  return driver === 'cloudinary'
    && Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function client() {
  if (!configured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

function folder(sub) {
  return `${process.env.CLOUDINARY_FOLDER || 'sportstures'}/${sub}`;
}

// Uploads a profile photo, cropped square around the face and saved as a 512px JPEG.
// Each user has one fixed public id, so a new photo replaces the old one.
function uploadAvatar(buffer, userId) {
  return new Promise((resolve, reject) => {
    const stream = client().uploader.upload_stream(
      {
        folder: folder('avatars'),
        public_id: `user_${userId}`,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        format: 'jpg',
        transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'face', quality: 'auto' }],
      },
      (err, result) => (err ? reject(err) : resolve({ url: result.secure_url, publicId: result.public_id }))
    );
    stream.end(buffer);
  });
}

// Uploads a team logo, shrunk to fit inside 512px (never cropped, so a crest keeps its shape and any
// transparent background). Each team has one fixed public id, so a new logo replaces the old one.
function uploadTeamLogo(buffer, teamId) {
  return new Promise((resolve, reject) => {
    const stream = client().uploader.upload_stream(
      {
        folder: folder('team-logos'),
        public_id: `team_${teamId}`,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        format: 'png',
        transformation: [{ width: 512, height: 512, crop: 'limit' }],
      },
      (err, result) => (err ? reject(err) : resolve({ url: result.secure_url, publicId: result.public_id }))
    );
    stream.end(buffer);
  });
}

async function deleteImage(publicId) {
  if (!publicId) return;
  await client().uploader.destroy(publicId, { invalidate: true });
}

module.exports = { isConfigured, uploadAvatar, uploadTeamLogo, deleteImage };
