import { Body, Controller, Post } from '@nestjs/common'; import { ApiTags } from '@nestjs/swagger'; import { IsArray, IsEmail, IsInt, IsString, Min, ValidateNested } from 'class-validator'; import { Type } from 'class-transformer'; import { OrdersService } from './orders.service';
class Item { @IsString() productId!:string; @IsString() lotCode!:string; @IsInt() @Min(1) quantity!:number; }
class CreateOrder { @IsEmail() email!:string; @IsString() shippingAddress!:string; @IsArray() @ValidateNested({each:true}) @Type(()=>Item) items!:Item[]; }
@ApiTags('orders') @Controller('orders') export class OrdersController { constructor(private orders:OrdersService){} @Post() create(@Body() body:CreateOrder){ return this.orders.create(body); } }
