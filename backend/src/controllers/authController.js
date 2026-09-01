// Auth controllers -- thin request/response wrappers around
// authService.js. Input validation lives here (shape/presence checks);
// business logic (bcrypt, token generation, atomic Mongo updates) stays
// in the service.

import { AppError } from '../middleware/AppError.js';

/**
 * @param {ReturnType<import('../services/authService.js').createAuthService>} authService
 */
export function createAuthController(authService) {
  async function login(req, res, next) {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        throw new AppError('VALIDATION_ERROR', 'Username and password are required.');
      }

      const result = await authService.login({
        username,
        password,
        userAgent: req.headers['user-agent']
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  async function refresh(req, res, next) {
    try {
      const { refreshToken } = req.body || {};
      if (typeof refreshToken !== 'string' || !refreshToken) {
        throw new AppError('VALIDATION_ERROR', 'A refresh token is required.');
      }

      const result = await authService.refresh({
        refreshToken,
        userAgent: req.headers['user-agent']
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  async function logout(req, res, next) {
    try {
      const { refreshToken } = req.body || {};
      if (typeof refreshToken !== 'string' || !refreshToken) {
        throw new AppError('VALIDATION_ERROR', 'A refresh token is required.');
      }

      // Locked contract: logout requires no access token, and always
      // returns success regardless of whether the presented token was
      // valid/known -- never an oracle for token validity.
      await authService.logout({ refreshToken });
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  async function changePassword(req, res, next) {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (
        typeof currentPassword !== 'string' || !currentPassword ||
        typeof newPassword !== 'string' || !newPassword
      ) {
        throw new AppError('VALIDATION_ERROR', 'Current and new password are required.');
      }

      // req.user.id is attached by requireAuth -- this route is
      // protected.
      await authService.changePassword({
        userId: req.user.id,
        currentPassword,
        newPassword
      });
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  return { login, refresh, logout, changePassword };
}
