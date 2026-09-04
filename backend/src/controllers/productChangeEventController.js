// ProductChangeEvent controller -- thin request/response wrapper around
// productChangeEventService.js, same style as every other controller in
// this project. No validation or DB logic here.

/**
 * @param {ReturnType<import('../services/productChangeEventService.js').createProductChangeEventService>} service
 */
export function createProductChangeEventController(service) {
  async function list(req, res, next) {
    try {
      const { productId } = req.query;
      const options = {};
      if (productId) options.productId = productId;
      const items = await service.list(req.user.id, options);
      res.status(200).json(items);
    } catch (err) {
      next(err);
    }
  }

  async function processEvent(req, res, next) {
    try {
      const doc = await service.processEvent(req.user.id, req.params.id, req.body);
      res.status(200).json(doc);
    } catch (err) {
      next(err);
    }
  }

  return { list, processEvent };
}
