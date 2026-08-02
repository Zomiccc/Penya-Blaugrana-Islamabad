/* ==========================================================================
   PBI INSTAGRAM POSTS — manually maintained, no API required
   ==========================================================================
   HOW TO ADD A NEW POST (do this each time you post something on Instagram):

   1. Save the photo or video from Instagram to your computer/phone
      (tap the photo → the ⋮ menu → Download, or just screenshot/save it).
   2. Upload that file to your WordPress media library, the same way the
      other images on this site are hosted (pbisb.com/wp-content/uploads/…).
      Copy the file's URL once it's uploaded.
   3. Copy the Instagram post's own URL too (open the post → Share/Copy Link).
   4. Add a new object to the TOP of the array below, following the same
      shape as the examples. Delete old ones from the bottom if the list
      gets too long — 12 is a good number to keep.
   5. Save this file and re-upload it alongside the rest of the site files.

   FIELDS:
   - type:      "image" or "video"
   - src:       direct URL to the photo/video file you uploaded in step 2
   - poster:    (video only, optional) a thumbnail image URL — if left blank,
                the video's first frame will show instead
   - permalink: the actual Instagram post URL from step 3 (tapping the tile
                opens the real post on Instagram in a new tab)
   - caption:   a short caption/description, shown on hover (optional)
   ========================================================================== */

var PBI_INSTAGRAM_POSTS = [
  {
    type: "image",
    src: "https://pbisb.com/wp-content/uploads/2026/07/MGA1546-scaled.jpg",
    permalink: "https://www.instagram.com/pbislamabad",
    caption: "Members gathered at a PBI screening"
  },
  {
    type: "image",
    src: "https://pbisb.com/wp-content/uploads/2026/07/soccer-ball-on-a-field-inside-a-stadium-full-of-fans-photo.jpg",
    permalink: "https://www.instagram.com/pbislamabad",
    caption: "A stadium full of supporters"
  },
  {
    type: "image",
    src: "https://pbisb.com/wp-content/uploads/2025/08/photo-1544366981-53db834f982a.avif",
    permalink: "https://www.instagram.com/pbislamabad",
    caption: "Barça fans celebrating together"
  },
  {
    type: "image",
    src: "https://pbisb.com/wp-content/uploads/2025/08/photo-1575343406218-42d896e03a85-1.avif",
    permalink: "https://www.instagram.com/pbislamabad",
    caption: "Supporters gathering before a match"
  },
  {
    type: "image",
    src: "https://pbisb.com/wp-content/uploads/2025/08/0e6527234716145dc9f71c479c1f347b.jpg",
    permalink: "https://www.instagram.com/pbislamabad",
    caption: "The PBI community"
  },
  {
    type: "image",
    src: "https://pbisb.com/wp-content/uploads/2025/08/SG_8977.webp",
    permalink: "https://www.instagram.com/pbislamabad",
    caption: "PBI board and members"
  }
];
