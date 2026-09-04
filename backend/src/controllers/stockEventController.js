// StockEvent controller -- thin request/response wrapper around
// stockEventService.js, same style as productController.js and
// classificationController.js. No transaction/quantity logic here.

/**
 * @param {ReturnType<import('../services/stockEventService.js').createStockEventService>} service
 */
export function createStockEventController(service) {
  async function list(req, res, next) {
    try {
      const { productId, includeReversed } = req.query;
      const options = {};
      if (productId) options.productId = productId;
      if (includeReversed === 'false') options.includeReversed = false;
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
