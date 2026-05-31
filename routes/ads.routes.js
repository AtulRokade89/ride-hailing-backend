const express = require("express");
const router = express.Router();
const adsController = require("../controllers/ads.controller");
const uploadAdsImage = require("../middlewares/uploadAdsImage");

// 📱 Mobile
router.get("/", adsController.getAds);

// 🛠️ Admin CREATE (🔥 MULTER HERE)
router.post(
  "/admin",
  uploadAdsImage.single("image"), // 👈 THIS WAS MISSING
  adsController.createAd
);

// 🛠️ Admin LIST
router.get("/admin/list", adsController.listAdsForAdmin);

// 🔁 Toggle enable / disable
router.patch(
  "/admin/:id/status",
  adsController.toggleAdStatus
);

// ✏️ Edit
router.put(
  "/admin/:id",
  uploadAdsImage.single("image"),
  adsController.updateAd
);

// 🗑️ Delete
router.delete(
  "/admin/:id",
  adsController.deleteAd
);

module.exports = router;
