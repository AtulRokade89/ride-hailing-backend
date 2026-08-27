//ads.controller.js
const pool = require('../db');
const path = require("path")

// 📱 MOBILE / PUBLIC API
const getAds = async (req, res) => {
  try {
    const { context,title } = req.query;

    if (!context) {
      return res.status(400).json({ error: 'context is required' });
    }

    const { rows } = await pool.query(
      `
      SELECT id, title, description, image_url, redirect_url
      FROM advertisements
      WHERE context = $1
        AND is_active = true
        AND NOW() BETWEEN start_at AND end_at
      ORDER BY priority ASC, created_at DESC
      LIMIT 5
      `,
      [context]
    );

    res.json({ ads: rows });
  } catch (err) {
    console.error('getAds error:', err);
    res.status(500).json({ error: 'Failed to fetch ads' });
  }
};

// 🛠️ ADMIN CREATE AD
const createAd = async (req, res) => {
  try {
    const {
      title,
      description,
      redirect_url,
      context,
      priority,
      is_active,
      start_at,
      end_at,
    } = req.body;

    // 👇 image multer se
    const image_url = req.file
      ? `/uploads/ads/${req.file.filename}`
      : null;

    if (!title || !description || !context || !end_at) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 🔒 max 5 active ads per context
    const { rows } = await pool.query(
      `
      SELECT COUNT(*)
      FROM advertisements
      WHERE context = $1
        AND is_active = true
        AND NOW() BETWEEN start_at AND end_at
      `,
      [context]
    );

    if (Number(rows[0].count) >= 5) {
      return res.status(400).json({
        error: 'Maximum 5 active ads allowed for this screen',
      });
    }

    await pool.query(
      `
      INSERT INTO advertisements
      (title, description, image_url, redirect_url, context, priority, is_active, start_at, end_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        title,
        description,
        image_url,
        redirect_url,
        context,
        priority || 1,
        is_active ?? true,
        start_at,
        end_at,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('createAd error:', err);
    res.status(500).json({ error: 'Failed to create advertisement' });
  }
};


// 🛠️ ADMIN LIST ADS
const listAdsForAdmin = async (req, res) => {
  try {
    const { context } = req.query;

    const { rows } = await pool.query(
      `
      SELECT *
      FROM advertisements
      WHERE ($1::text IS NULL OR context = $1)
      ORDER BY created_at DESC
      `,
      [context || null]
    );

    res.json({ ads: rows });
  } catch (err) {
    console.error('listAdsForAdmin error:', err);
    res.status(500).json({ error: 'Failed to load ads' });
  }
};

;

// 🖼️ IMAGE UPLOAD CONTROLLER
const uploadAdImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const imageUrl = `/uploads/ads/${req.file.filename}`;

    res.json({
      success: true,
      image_url: imageUrl,
    });
  } catch (err) {
    console.error("uploadAdImage error:", err);
    res.status(500).json({ error: "Image upload failed" });
  }
};

// 🟢 ENABLE / DISABLE AD
const toggleAdStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
      return res.status(400).json({ error: "is_active must be boolean" });
    }

    await pool.query(
      `
      UPDATE advertisements
      SET is_active = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [is_active, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("toggleAdStatus error:", err);
    res.status(500).json({ error: "Failed to update ad status" });
  }
};

// ✏️ UPDATE AD
const updateAd = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      redirect_url,
      context,
      priority,
      is_active,
      start_at,
      end_at,
    } = req.body;

    const image_url = req.file
      ? `/uploads/ads/${req.file.filename}`
      : undefined; // undefined => don't update

    const fields = [];
    const values = [];
    let idx = 1;

    const add = (key, val) => {
      if (val !== undefined) {
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      }
    };

    add("title", title);
    add("description", description);
    add("redirect_url", redirect_url);
    add("context", context);
    add("priority", priority);
    add(
  "is_active",
  is_active === undefined
    ? undefined
    : is_active === true || is_active === "true"
);
    add("start_at", start_at);
    add("end_at", end_at);
    add("image_url", image_url);

    if (!fields.length) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await pool.query(
      `
      UPDATE advertisements
      SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = $${idx}
      `,
      [...values, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("updateAd error:", err);
    res.status(500).json({ error: "Failed to update ad" });
  }
};

// 🗑️ DELETE AD
const deleteAd = async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM advertisements WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("deleteAd error:", err);
    res.status(500).json({ error: "Failed to delete ad" });
  }
};

module.exports = {
  getAds,
  createAd,
  listAdsForAdmin, 
  uploadAdImage,
  toggleAdStatus,
  updateAd,
  deleteAd, 
};
