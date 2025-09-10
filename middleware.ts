import type { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth';
import { storage } from './storage';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
      };
    }
  }
}

/**
 * Middleware to authenticate JWT tokens
 */
export async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  try {
    const token = AuthService.extractTokenFromHeader(req.headers.authorization);
    
    if (!token) {
      return res.status(401).json({ message: 'Access token required' });
    }

    const decoded = AuthService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    // Verify user still exists and is active
    const user = await storage.getUser(decoded.userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Add user info to request
    req.user = {
      id: user.id,
      username: user.username,
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ message: 'Authentication failed' });
  }
}

/**
 * Optional authentication middleware - continues even if no token
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = AuthService.extractTokenFromHeader(req.headers.authorization);
    
    if (token) {
      const decoded = AuthService.verifyToken(token);
      if (decoded) {
        const user = await storage.getUser(decoded.userId);
        if (user) {
          req.user = {
            id: user.id,
            username: user.username,
          };
        }
      }
    }

    next();
  } catch (error) {
    // Continue without authentication if there's an error
    next();
  }
}

/**
 * Rate limiting middleware for auth endpoints
 */
const authAttempts = new Map<string, { count: number; lastAttempt: Date }>();

export function authRateLimit(maxAttempts: number = 5, windowMs: number = 15 * 60 * 1000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = new Date();
    
    const attempts = authAttempts.get(ip);
    
    if (attempts) {
      // Reset if window has passed
      if (now.getTime() - attempts.lastAttempt.getTime() > windowMs) {
        authAttempts.set(ip, { count: 1, lastAttempt: now });
      } else if (attempts.count >= maxAttempts) {
        return res.status(429).json({ 
          message: 'Too many authentication attempts. Please try again later.' 
        });
      } else {
        attempts.count++;
        attempts.lastAttempt = now;
      }
    } else {
      authAttempts.set(ip, { count: 1, lastAttempt: now });
    }
    
    next();
  };
}

/**
 * Clear successful auth attempts for an IP
 */
export function clearAuthAttempts(ip: string) {
  authAttempts.delete(ip);
}