const padDatePart = (value: number) => String(value).padStart(2, "0");

export const formatDateByLocale = (value: string, activeLocale: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());

  switch (activeLocale) {
    case "hu":
      return `${year}/${month}/${day}`;
    case "en":
      return `${day}/${month}/${year}`;
    default:
      return new Intl.DateTimeFormat(activeLocale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
  }
};
