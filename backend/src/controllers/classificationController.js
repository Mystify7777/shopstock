// Classification controllers -- thin request/response wrappers around
// classificationService.js, mirroring authController.js's own style
// (shape/presence checks at this layer where trivial; anything
// involving persistence, ownership, or the id-identity rule stays in
// the service). One factory produces the list/upsert handler pair for
// any of the four classification resources.

/**
 * @param {ReturnType<import('../services/classificationService.js').createClassificationService>} service
 */
export function createClassificationController(service) {
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
