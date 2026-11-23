"use client";
import Link from "next/link";
import { useContext, type ComponentProps } from "react";
import { DeviceNavigation } from "../lib/workspace-router";
export default function WorkspaceLink({
  onClick,
  ...props
}: ComponentProps<typeof Link>) {
  const navigation = useContext(DeviceNavigation);
  return (
    <Link
      {...props}
      href={
        navigation &&
        typeof props.href === "string" &&
        props.href.startsWith("/") &&
        !props.href.startsWith("//")
          ? "/device#" + props.href
          : props.href
      }
      prefetch={navigation ? false : props.prefetch}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          navigation &&
          typeof props.href === "string" &&
          props.href.startsWith("/") &&
          !props.href.startsWith("//") &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          props.target !== "_blank"
        ) {
          event.preventDefault();
          navigation.navigate(props.href);
        }
      }}
    />
  );
}
