import { useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, colors, styles } from "./ui";

export type Option = { id: string; label: string; detail?: string };
export function Select({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={() => {
          setSearch("");
          setOpen(true);
        }}
        style={[styles.input, styles.between]}
      >
        <Text
          numberOfLines={2}
          style={{ flex: 1, color: value ? colors.ink : colors.muted }}
        >
          {options.find((option) => option.id === value)?.label ?? "Select…"}
        </Text>
        <Ionicons name="chevron-down" size={17} color={colors.muted} />
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView style={styles.page}>
          <View style={styles.content}>
            <Text style={styles.title}>{label}</Text>
            <TextInput
              autoFocus
              accessibilityLabel={`Search ${label}`}
              placeholder="Search…"
              style={styles.input}
              value={search}
              onChangeText={setSearch}
            />
            <Button
              title="Close"
              variant="outline"
              onPress={() => setOpen(false)}
            />
          </View>
          <FlatList
            data={options.filter((option) =>
              `${option.label} ${option.detail ?? ""}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24 }}
            ListEmptyComponent={
              <Text style={styles.muted}>No matching options.</Text>
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
                style={[
                  styles.card,
                  { marginBottom: 8 },
                  item.id === value && { borderColor: colors.green },
                ]}
              >
                <Text style={styles.heading}>{item.label}</Text>
                {item.detail ? (
                  <Text style={styles.muted}>{item.detail}</Text>
                ) : null}
              </Pressable>
            )}
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}
