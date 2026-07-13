Promise.all([
  fetch('/eam-assets.json').then(function(r) { return r.json(); }),
  fetch('/eam-enchantments.json').then(function(r) { return r.json(); })
]).then(function(results) {
  postMessage({ assets: results[0], enchantments: results[1] });
}).catch(function() {
  postMessage(null);
});
