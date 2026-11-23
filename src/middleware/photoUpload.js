const multer = require('multer');
const { errorBody } = require('../utils/serializers');

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// Keeps one uploaded image in memory (it goes straight on to Cloudinary) and turns multer's errors into ours.
// The image arrives in a form field named "photo".
function receivePhoto(req, res, next) {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } })
    .single('photo')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json(errorBody('FILE_TOO_LARGE', 'The photo must be 5 MB or smaller'));
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json(errorBody('INVALID_UPLOAD', 'Send one image in a form field named "photo"'));
      }
      return next(err);
    });
}

module.exports = { receivePhoto, MAX_PHOTO_BYTES };
