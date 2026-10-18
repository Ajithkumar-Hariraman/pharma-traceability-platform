import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AuthService } from './auth.service';
type AuthRequest = {
  headers: { authorization?: string };
  user?: Awaited<ReturnType<AuthService['currentUser']>>;
};
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.user = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('register') register(@Body() body: unknown) {
    return this.auth.register(body);
  }
  @Post('login') login(@Body() body: unknown) {
    return this.auth.login(body);
  }
  @Post('refresh') refresh(@Body() body: unknown) {
    return this.auth.refresh(body);
  }
  @Post('logout') logout(@Body() body: unknown) {
    return this.auth.logout(body);
  }
  @Get('me') @UseGuards(AccessGuard) me(@Req() request: AuthRequest) {
    return request.user;
  }
}
