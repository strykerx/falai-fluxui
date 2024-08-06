const express = require('express');
const fal = require('@fal-ai/serverless-client');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const exifReader = require('exif-reader');
require('dotenv').config();
const multer = require('multer');  

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Configure fal.ai client with your API key
fal.config({
  credentials: process.env.FAL_KEY
});

// Ensure the images directory exists
const imagesDir = path.join(__dirname, 'images');
fs.mkdir(imagesDir, { recursive: true });

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

app.post('/generate-image', async (req, res) => {
  try {
    const { model, prompt, image_size, num_inference_steps, image_count } = req.body;

    console.log('Request payload:', req.body);

    const input = {
      prompt,
      image_size,
      num_inference_steps: parseInt(num_inference_steps),
      num_images: parseInt(image_count) || 1
    };

    if (model === 'fal-ai/flux/dev') {
      input.guidance_scale = parseFloat(req.body.guidance_scale);
      input.enable_safety_checker = false;
    } else if (model === 'fal-ai/flux-pro') {
      input.guidance_scale = parseFloat(req.body.guidance_scale);
      input.safety_tolerance = req.body.safety_tolerance;
    } else if (model === 'fal-ai/flux/schnell') {
      input.enable_safety_checker = false;
    }

    const result = await fal.subscribe(model, {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          console.log(update.logs.map((log) => log.message));
        }
      },
    });


    const imageUrls = [];

    for (const image of result.images) {
      // Download and save the image
      const imageUrl = image.url;
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data, 'binary');

      const filename = `${uuidv4()}.jpg`;
      const filePath = path.join(imagesDir, filename);

      // Add metadata to the image
      const metadata = {
        model,
        prompt,
        image_size,
        num_inference_steps,
        ...(model === 'fal-ai/flux/dev' && { guidance_scale: input.guidance_scale }),
        ...(model === 'fal-ai/flux-pro' && { guidance_scale: input.guidance_scale, safety_tolerance: input.safety_tolerance }),
        seed: result.seed,
        timestamp: new Date().toISOString()
      };

      const metadataString = JSON.stringify(metadata);
      console.log('Saving metadata:', metadataString);

      await sharp(buffer)
        .withMetadata({
          exif: {
            IFD0: { ImageDescription: metadataString }
          }
        })
        .toFile(filePath);

      console.log('Image saved with metadata:', filePath);

      imageUrls.push(`/images/${filename}`);
    }

    res.json({ image_urls: imageUrls });
  } catch (error) {
    console.error('Error generating image:', error);
    if (error.body && error.body.detail) {
      console.error('Validation errors:', JSON.stringify(error.body.detail, null, 2));
    }
    res.status(500).json({ error: 'Error generating image', details: error.message, validationErrors: error.body?.detail });
  }
});

app.get('/gallery', async (req, res) => {
  try {
    const files = await fs.readdir(imagesDir);
    const images = await Promise.all(files
      .filter(file => file.endsWith('.jpg'))
      .map(async file => {
        const filePath = path.join(imagesDir, file);
        const stats = await fs.stat(filePath);
        return {
          filename: file,
          url: `/images/${file}`,
          created: stats.birthtime
        };
      }));
    
    images.sort((a, b) => b.created - a.created);
    res.json(images);
  } catch (error) {
    console.error('Error reading gallery:', error);
    res.status(500).json({ error: 'Error reading gallery', details: error.message });
  }
});

app.get('/image-metadata/:filename', async (req, res) => {
  const filePath = path.join(imagesDir, req.params.filename);
  console.log('Attempting to read metadata from:', filePath);

  try {
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!fileExists) {
      console.log('File not found:', filePath);
      return res.status(404).json({ error: 'Image not found' });
    }

    const metadata = await sharp(filePath).metadata();
    console.log('Sharp metadata:', metadata);

    if (metadata.exif) {
      console.log('EXIF data found, length:', metadata.exif.length);
      const exifData = exifReader(metadata.exif);
      console.log('Parsed EXIF data:', exifData);

      if (exifData.Image && exifData.Image.ImageDescription) {
        const imageDescription = exifData.Image.ImageDescription;
        console.log('Image description found:', imageDescription);
        try {
          const parsedMetadata = JSON.parse(imageDescription);
          res.json(parsedMetadata);
        } catch (parseError) {
          console.error('Error parsing image description:', parseError);
          res.status(500).json({ error: 'Error parsing image description', details: parseError.message });
        }
      } else {
        console.log('No ImageDescription found in EXIF data');
        res.status(404).json({ error: 'Metadata not found in EXIF' });
      }
    } else {
      console.log('No EXIF data found');
      res.status(404).json({ error: 'No EXIF data found' });
    }
  } catch (error) {
    console.error('Error reading metadata:', error);
    res.status(500).json({ error: 'Error reading metadata', details: error.message });
  }
});

app.post('/generate-img2img', upload.single('file'), async (req, res) => {
  try {
    const { prompt, strength, image_size, num_inference_steps, guidance_scale } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Upload the file to fal.ai storage
    const fileContent = await fs.readFile(file.path);
    const uploadedFileUrl = await fal.storage.upload(fileContent);

    const input = {
      image_url: uploadedFileUrl,
      prompt,
      strength: parseFloat(strength),
      image_size,
      num_inference_steps: parseInt(num_inference_steps),
      guidance_scale: parseFloat(guidance_scale),
      enable_safety_checker: false
    };

    const result = await fal.subscribe("fal-ai/flux/dev/image-to-image", {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          console.log(update.logs.map((log) => log.message));
        }
      },
    });

    const imageUrls = [];

    for (const image of result.images) {
      const imageUrl = image.url;
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data, 'binary');

      const filename = `${uuidv4()}.jpg`;
      const filePath = path.join(imagesDir, filename);

      const metadata = {
        prompt,
        strength,
        image_size,
        num_inference_steps,
        guidance_scale,
        seed: result.seed,
        timestamp: new Date().toISOString()
      };

      const metadataString = JSON.stringify(metadata);

      await sharp(buffer)
        .withMetadata({
          exif: {
            IFD0: { ImageDescription: metadataString }
          }
        })
        .toFile(filePath);

      imageUrls.push(`/images/${filename}`);
    }

    // Clean up the uploaded file
    await fs.unlink(file.path);

    res.json({ image_urls: imageUrls });
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ error: 'Error generating image', details: error.message });
  }
});


app.use('/images', express.static(imagesDir));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});