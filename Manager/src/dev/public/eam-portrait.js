(function () {
  var assets = window.EAMAssets || {};
  var skins = assets.skins || {};
  var skinsheets = assets.skinsheets || {};
  var textures = assets.textures || {};
  var textiles = assets.textiles || {};
  var skinSheetPromises = Object.create(null);
  var textileSheetPromises = Object.create(null);
  var textileSheets = Object.create(null);
  var portraitPromises = Object.create(null);
  var patternCache = Object.create(null);

  function pixelComponent(imageData, x, y, i) {
    return imageData.data[((imageData.width * y + x) << 2) + i];
  }

  function pixelColor(imageData, x, y) {
    var offset = (imageData.width * y + x) << 2;
    var data = imageData.data;
    return 'rgba(' + data[offset] + ',' + data[offset + 1] + ',' + data[offset + 2] + ',' + (data[offset + 3] / 255) + ')';
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  function extractSkins(img, size) {
    var canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0);
    var index = 0;
    var result = [];
    for (var y = 0; y < canvas.height; y += size * 3, index++) {
      result[index] = ctx.getImageData(0, y, size, size);
    }
    return result;
  }

  function extractSprites(img, size) {
    var canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0);
    var index = 0;
    var result = [];
    for (var y = 0; y < canvas.height; y += size) {
      for (var x = 0; x < canvas.width; x += size, index++) {
        result[index] = ctx.getImageData(x, y, size, size);
      }
    }
    return result;
  }

  function getSkinEntry(type, skin) {
    return skins[String(skin || 0)] || skins[String(type || 0)] || null;
  }

  function loadSkinSheetSprites(sheetName, size) {
    if (!sheetName || !skinsheets[sheetName]) {
      return Promise.resolve([]);
    }
    if (!skinSheetPromises[sheetName]) {
      skinSheetPromises[sheetName] = loadImage(skinsheets[sheetName]).then(function (img) {
        return extractSkins(img, size);
      }).catch(function () {
        return [];
      });
    }
    return skinSheetPromises[sheetName];
  }

  function loadTextileSheetSprites(sheetId) {
    var key = String(sheetId || '');
    if (!key || !textiles[key]) {
      return Promise.resolve([]);
    }
    if (!textileSheetPromises[key]) {
      textileSheetPromises[key] = loadImage(textiles[key]).then(function (img) {
        return extractSprites(img, Number(key) || 8);
      }).catch(function () {
        return [];
      });
      textileSheetPromises[key].then(function (value) {
        textileSheets[key] = value;
        return value;
      });
    }
    return textileSheetPromises[key];
  }

  function getTextureValue(textureId, index) {
    var entry = textures[String(textureId || 0)];
    return entry ? Number(entry[index] || 0) : 0;
  }

  function getTextureSheetId(texValue) {
    return (Number(texValue) >>> 24) || 0;
  }

  function loadTextureResources(texValues) {
    var seen = Object.create(null);
    var loads = [];
    texValues.forEach(function (texValue) {
      var sheetId = getTextureSheetId(texValue);
      if (sheetId > 1 && !seen[sheetId]) {
        seen[sheetId] = true;
        loads.push(loadTextileSheetSprites(sheetId));
      }
    });
    return Promise.all(loads);
  }

  function makeTexturePattern(texValue, ratio) {
    var key = String(texValue || 0) + ':' + String(ratio || 0);
    if (patternCache[key]) return patternCache[key];

    var sheetId = getTextureSheetId(texValue);
    var spriteIndex = Number(texValue) & 0xffffff;
    if (sheetId === 0) {
      patternCache[key] = 'transparent';
      return patternCache[key];
    }
    if (sheetId === 1) {
      var color = spriteIndex.toString(16);
      while (color.length < 6) color = '0' + color;
      patternCache[key] = '#' + color;
      return patternCache[key];
    }

    var sprites = textileSheets[String(sheetId)];
    if (!sprites || !sprites[spriteIndex]) return 'transparent';

    var sprite = sprites[spriteIndex];
    var srcCanvas = document.createElement('canvas');
    srcCanvas.width = sprite.width;
    srcCanvas.height = sprite.height;
    var srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) return 'transparent';
    srcCtx.imageSmoothingEnabled = false;
    srcCtx.putImageData(sprite, 0, 0);

    var scaledCanvas = document.createElement('canvas');
    var scale = ratio / 5;
    scaledCanvas.width = Math.max(1, Math.round(sprite.width * scale));
    scaledCanvas.height = Math.max(1, Math.round(sprite.height * scale));
    var scaledCtx = scaledCanvas.getContext('2d');
    if (!scaledCtx) return 'transparent';
    scaledCtx.imageSmoothingEnabled = false;
    scaledCtx.drawImage(srcCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);

    patternCache[key] = scaledCtx.createPattern(scaledCanvas, 'repeat') || 'transparent';
    return patternCache[key];
  }

  function renderPortrait(type, skin, tex1Id, tex2Id, adjust) {
    var cacheKey = [type || 0, skin || 0, tex1Id || 0, tex2Id || 0, adjust || 0].join(':');
    if (portraitPromises[cacheKey]) return portraitPromises[cacheKey];

    portraitPromises[cacheKey] = Promise.resolve().then(function () {
      var skinEntry = getSkinEntry(type, skin);
      if (!skinEntry) return '';

      var size = skinEntry[2] ? 16 : 8;
      var ratio = skinEntry[2] ? 2 : 4;
      var sheetName = String(skinEntry[3] || 'players');
      var sheetIndex = Number(skinEntry[1] || 0);
      var tex1Value = getTextureValue(tex1Id, 0);
      var tex2Value = getTextureValue(tex2Id, 2);

      return Promise.all([
        loadSkinSheetSprites(sheetName, size),
        loadSkinSheetSprites(sheetName + 'Mask', size),
        loadTextureResources([tex1Value, tex2Value]),
      ]).then(function (results) {
        var sprites = results[0] || [];
        var masks = results[1] || [];
        var sprite = sprites[sheetIndex];
        var mask = masks[sheetIndex];
        if (!sprite) return '';

        var canvas = document.createElement('canvas');
        canvas.width = 34;
        canvas.height = 34;
        var ctx = canvas.getContext('2d');
        if (!ctx) return '';
        var texture1Pattern = tex1Value ? makeTexturePattern(tex1Value, ratio) : 'transparent';
        var texture2Pattern = tex2Value ? makeTexturePattern(tex2Value, ratio) : 'transparent';

        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.translate(1, 1);

        for (var xi = 0; xi < size; xi++) {
          var x = xi * ratio;
          for (var yi = 0; yi < size; yi++) {
            if (pixelComponent(sprite, xi, yi, 3) < 2) continue;
            var y = yi * ratio;

            ctx.fillStyle = pixelColor(sprite, xi, yi);
            ctx.fillRect(x, y, ratio, ratio);

            if (mask && pixelComponent(mask, xi, yi, 3) > 1) {
              var red = pixelComponent(mask, xi, yi, 0);
              var green = pixelComponent(mask, xi, yi, 1);
              var volume = 0;
              var chosenPattern = null;
              if (red > green && texture1Pattern !== 'transparent') {
                volume = red;
                chosenPattern = texture1Pattern;
              } else if (green > red && texture2Pattern !== 'transparent') {
                volume = green;
                chosenPattern = texture2Pattern;
              }
              if (chosenPattern) {
                ctx.fillStyle = chosenPattern;
                ctx.fillRect(x, y, ratio, ratio);
                ctx.fillStyle = 'rgba(0,0,0,' + ((255 - volume) / 255) + ')';
                ctx.fillRect(x, y, ratio, ratio);
              }
            }

            ctx.save();
            ctx.globalCompositeOperation = 'destination-over';
            ctx.strokeRect(x - 0.5, y - 0.5, ratio + 1, ratio + 1);
            ctx.restore();
          }
        }

        ctx.restore();
        return canvas.toDataURL();
      });
    });

    return portraitPromises[cacheKey];
  }

  window.renderEamPortrait = renderPortrait;
})();
