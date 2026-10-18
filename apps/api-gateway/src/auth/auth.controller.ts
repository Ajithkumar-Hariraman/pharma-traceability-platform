import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  ForbiddenException,
  UnauthorizedException,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthProxyService } from './auth-proxy.service';
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly proxy: AuthProxyService,
    private readonly config: ConfigService,
  ) {}
  private options() {
    return {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'strict' as const,
      path: '/api/auth',
      maxAge: 7 * 86400000,
    };
  }
  private checkOrigin(req: Request) {
    // Browser writes must be same-origin; API clients without Origin remain supported.
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('Cross-origin request rejected');
    if (req.headers.origin) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        throw new ForbiddenException('Invalid origin');
      }
      if (origin.host !== req.headers.host)
        throw new ForbiddenException('Cross-origin request rejected');
    }
  }
  private refreshToken(req: Request) {
    const token = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('pharma_refresh='))
      ?.slice('pharma_refresh='.length);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException(
        'Your session has expired. Please sign in again',
      );
    return token;
  }
  @Post('register') register(@Req() req: Request, @Body() body: unknown) {
    this.checkOrigin(req);
    return this.proxy.forward('register', body);
  }
  private async session(
    action: 'login' | 'refresh',
    req: Request,
    res: Response,
    body: unknown,
  ) {
    this.checkOrigin(req);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await this.proxy.forward(
        action,
        action === 'refresh' ? { refreshToken: this.refreshToken(req) } : body,
      );
      if (!('refreshToken' in result))
        throw new Error('Invalid token response');
      res.cookie('pharma_refresh', result.refreshToken, this.options());
      return { accessToken: result.accessToken };
    } catch (error) {
      if (
        action === 'refresh' &&
        error instanceof HttpException &&
        error.getStatus() === 401
      )
        res.clearCookie('pharma_refresh', this.options());
      throw error;
    }
  }
  @Post('login') @HttpCode(200) login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return this.session('login', req, res, body);
  }
  @Post('refresh') @HttpCode(200) refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.session('refresh', req, res, {});
  }
  @Post('logout') @HttpCode(200) async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.checkOrigin(req);
    res.setHeader('Cache-Control', 'no-store');
    let token: string;
    try {
      token = this.refreshToken(req);
    } catch {
      res.clearCookie('pharma_refresh', this.options());
      return { success: true };
    }
    const result = await this.proxy.forward('logout', { refreshToken: token });
    res.clearCookie('pharma_refresh', this.options());
    return result;
  }
  @Get('me') me(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.proxy.forward('me', undefined, req.headers.authorization);
  }
}
