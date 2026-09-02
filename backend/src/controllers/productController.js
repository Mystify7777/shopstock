// Product controller -- thin request/response wrapper around
// productService.js, same style as classificationController.js and
// authController.js. No business logic lives here.

/**
 * @param {ReturnType<import('../services/productService.js').createProductService>} service
 */
export function createProductController(service) {
  async function list(req, res, next) {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const items = await service.list(req.user.id, { includeArchived });
      res.status(200).json(items);
    } catch (err) {
      next(err);
    }
  }

  async function upsert(req, res, next) {
    try {
      const doc = await service.upsert(req.user.id, req.params.id, req.body);
      res.status(200).json(doc);
    } catch (err) {
      next(err);
    }
  }

  return { list, upsert };
}
